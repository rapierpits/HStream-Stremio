# HStream Stremio Addon

A Stremio addon that lets you watch content from hstream.moe directly in Stremio.

## Features

- Browse and watch videos from hstream.moe
- High quality video streams (up to 4K)
- Pagination support for browsing large catalogs
- Fast parallel loading of content

## Installation

1. Go to the addon URL (once deployed)
2. Click "Install"
3. Confirm the installation in Stremio

## Development

To run the addon locally:

```bash
npm install
npm start
```

Then open `http://localhost:7000` in your browser and click "Install".

## Deployment

The addon can be deployed to Render.com:

1. Fork this repository
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. Use the following settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node.js version: 16 or higher

## License

This project is for educational purposes only. 