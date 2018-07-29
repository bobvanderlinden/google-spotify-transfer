const express = require("express");
const request = require("request-promise-native");
const opn = require("opn");
const querystring = require("querystring");

function promisify(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  };
}

function base64Encode(str) {
  return Buffer.from(str).toString("base64");
}

function slices(arr, sliceLength) {
  const remaining = arr.slice(0);
  const result = [];
  while (remaining.length > sliceLength) {
    const slice = remaining.splice(0, sliceLength);
    result.push(slice);
  }
  if (remaining.length > 0) {
    result.push(remaining);
  }
  return result;
}

function wait(milliseconds) {
  console.log(`Waiting for ${milliseconds} milliseconds...`);
  return new Promise((resolve, reject) => {
    setTimeout(resolve, milliseconds);
  });
}

// This function lets the user authenticate using OAuth2 in their browser.
function authenticate({
  clientId,
  clientSecret,
  scopes,
  authenticateUrl,
  tokenUrl,
  httpPort,
  loginPath,
  callbackPath
}) {
  return new Promise(async (resolve, reject) => {
    const redirectUri = `http://127.0.0.1:${httpPort}${callbackPath}`;
    const app = express();

    // Create a endpoint where we can send the browser to, which redirects to the correct
    // authentication URL.
    const tokenResponseBodyPromise = new Promise((resolve, _reject) => {
      app.get(loginPath, (_req, res) => {
        res.redirect(
          authenticateUrl +
            "?" +
            querystring.stringify({
              response_type: "code",
              client_id: clientId,
              scope: scopes.join(" "),
              redirect_uri: redirectUri
            })
        );
        res.end();
      });

      // Create a endpoint for the OAuth2 callback URL.
      // We'll receive the authentication code here as a query parameter.
      app.get(callbackPath, async (req, res) => {
        const code = req.query.code;

        // We received the authentication code.
        // Now we can fetch the actual tokens we need to
        // do furher requests (like 'access_token')
        const responseBody = await request({
          method: "POST",
          url: tokenUrl,
          headers: {
            Authorization: `Basic ${base64Encode(
              `${clientId}:${clientSecret}`
            )}`,
            Accept: "application/json"
          },
          form: {
            grant_type: "authorization_code",
            code: code,
            redirect_uri: redirectUri
          }
        });
        resolve(JSON.parse(responseBody));
        res.end();
      });
    });

    const server = await new Promise((resolve, reject) => {
      const server = app.listen(httpPort, "127.0.0.1", undefined, err => {
        if (err) {
          return reject(err);
        }
        resolve(server);
      });
    });

    opn(`http://127.0.0.1:${httpPort}${loginPath}`);

    const tokenResponseBody = await tokenResponseBodyPromise;

    await promisify(server.close).call(server);

    resolve(tokenResponseBody);
  });
}

function createClient({ urlPrefix, tokenType, token }) {
  return async options => {
    const { method, url, query, body, headers } = options;
    const requestOptions = {
      method: method || "GET",
      url: `${urlPrefix}${url}`,
      qs: query,
      json: body,
      headers: {
        Authorization: `${tokenType} ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers
      },
      simple: false,
      resolveWithFullResponse: true
    };

    return await attemptRequest();

    async function reattemptRequest() {
      // Always wait at least one second before reattempting another request.
      // We don't want to make the server mad.
      await wait(1000);
      return await attemptRequest();
    }

    async function attemptRequest() {
      let response;
      try {
        response = await request(requestOptions);
      } catch (err) {
        // Some mirrors of Spotify are not always available. Since every request goes
        // through the load balancer, we sometimes run into unavailable servers.
        // Just retry the request.
        if (err.name === "RequestError" && err.cause.code === "ECONNRESET") {
          return await reattemptRequest();
        } else {
          throw err;
        }
      }

      switch (response.statusCode) {
        case 429:
          // When doing too many requests, the Spotify API will respond with 429 and set
          // the 'Retry-After' header to the number of seconds we'll need to wait.
          const retryAfter = parseInt(response.headers["retry-after"], 10) || 1;
          await wait(retryAfter * 1000);
          return await reattemptRequest();
        case 200:
          if (response.body === undefined) {
            // Spotify PUT APIs respond with no body and at the same time status 200.
            return undefined;
          } else {
            return JSON.parse(response.body);
          }
        case 201:
          return null;
        case 204:
          return null;
        case 502:
          return await reattemptRequest();
        default:
          throw new Error(
            `Invalid status code ${response.statusCode}: ${JSON.stringify(
              response.body
            )}`
          );
      }
    }
  };
}

async function findSpotifyTrack(spotifyClient, { artists, title }) {
  // Build a query string for the search API in the form of:
  // artist:The First Artist artist:The Second Artist track:The Title Of The Track
  // ... and find the first track that matches.
  const artistQueryTags = artists.map(artist => `artist:${artist}`);
  const trackQueryTags = [`track:${title}`];
  const queryTags = [...artistQueryTags, ...trackQueryTags];
  const responseBody = await spotifyClient({
    url: "/v1/search",
    query: {
      q: queryTags.join(" "),
      type: "track"
    }
  });
  return responseBody.tracks.items[0];
}

async function findSpotifyTrackByGoogleMusicTrack(
  spotifyClient,
  googleMusicTrack
) {
  // Google Music tends to join multiple artists using '&'.
  // We'll split these up so that Spotify can search for them separately.
  const artists = googleMusicTrack.artist.split(" & ");

  // Google Music tends to append a second artist to a title using:
  // (feat. The Second Artist)
  // We'll interpret this as a separate artist and remove the mention from the title.
  const title = googleMusicTrack.title.replace(
    / \(feat\. (.*)\)/,
    (match, artist) => {
      artists.push(artist);
      return "";
    }
  );
  return await findSpotifyTrack(spotifyClient, {
    artists,
    title
  });
}

async function run() {
  console.log("Authenticating Spotify...");
  const spotifyTokens = await authenticate({
    clientId: "4dda6e4c2539432a993f0a4175b537f2",
    clientSecret: "2a9be6408d1f470f8feec24f20503c00",
    scopes: ["user-library-modify"],
    authenticateUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    httpPort: 3000,
    loginPath: "/spotify/login",
    callbackPath: "/spotify/callback"
  });

  const spotifyClient = createClient({
    urlPrefix: "https://api.spotify.com",
    tokenType: spotifyTokens.token_type,
    token: spotifyTokens.access_token
  });

  console.log("Authenticating Google Play Music...");
  const googleTokens = await authenticate({
    clientId:
      "595289982231-vfcvacp33vi4ebiges2s5i2vq9mdtb5k.apps.googleusercontent.com",
    clientSecret: "LwCMwxMJB20wlXVCIzgXlRT7",
    scopes: ["https://www.googleapis.com/auth/musicmanager"],
    authenticateUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://www.googleapis.com/oauth2/v4/token",
    httpPort: 3000,
    loginPath: "/google/login",
    callbackPath: "/google/callback"
  });

  const googleMusicClient = createClient({
    urlPrefix: "https://play.google.com/music",
    tokenType: googleTokens.token_type,
    token: googleTokens.access_token
  });

  // Fetch all favorites from Google Music
  const favoritesResponse = await googleMusicClient({
    method: "POST",
    url: "/services/getephemthumbsup"
  });
  const googleMusicTracks = favoritesResponse.track;

  // Find the Spotify equivalent tracks and store only their ids
  const spotifyTrackIds = [];
  for (let googleMusicTrack of googleMusicTracks) {
    const spotifyTrack = await findSpotifyTrackByGoogleMusicTrack(
      spotifyClient,
      googleMusicTrack
    );
    if (!spotifyTrack) {
      console.warn(
        `Not found: ${googleMusicTrack.artist} - ${googleMusicTrack.title}`
      );
      continue;
    }
    console.log(
      `${spotifyTrack.id} | ${googleMusicTrack.artist} - ${
        googleMusicTrack.title
      } | ${spotifyTrack.artists.map(artist => artist.name).join(", ")} - ${
        spotifyTrack.name
      }`
    );
    spotifyTrackIds.push(spotifyTrack.id);
  }

  // Add the found Spotify tracks to the Spotify favorites.
  // Since the Spotify API allows up to 50 tracks to be added at a time
  // We'll split the list of ids into slices of max 50 and add each slice.
  for (let spotifyTrackIdSlice of slices(spotifyTrackIds, 50)) {
    console.log(`Adding ${spotifyTrackIdSlice.length} tracks to favorites...`);
    await spotifyClient({
      method: "PUT",
      url: `/v1/me/tracks`,
      body: {
        ids: spotifyTrackIdSlice
      }
    });
  }
}

run()
  .then(() => {
    // We finished succesfully, but we'll just wait for nodejs to close
    // by itself if any remaining handlers are still running.
    // There shouldn't be any.
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
