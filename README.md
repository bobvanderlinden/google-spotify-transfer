# Google Music to Spotify Favorites Transfer

A tool to copy favorites from Google Music to Spotify.

I used this to move to Spotify.

## Installation

```
npm install
```

## Usage

First run the tool:

```
npm start
```

A browser will appear asking for your Spotify credentials.

Once entered, another browser will appear asking for your Google credentials.

These steps will not ask for your password if you were already logged in.

## Workings

The core of this tool uses Google Music and Spotify APIs.

For the authentication, a Express server is created that functions as a local OAuth2 server.
I already registered an application for both Google Music as well as Spotify that is hard-coded into this tool.
