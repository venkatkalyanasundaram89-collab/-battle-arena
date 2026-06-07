# Build Battle Arena

Build Battle Arena is now a Chrome-ready website. It is a small browser build-and-shoot duel game with:

- online room codes
- two-player multiplayer
- bot mode
- shooting
- buildable walls

## Open in Google Chrome

```bash
npm start
```

Then open this website URL in Google Chrome:

```text
http://localhost:3000
```

You can also open that URL from the project with:

```bash
npm run open:chrome
```

Do not open `index.html` directly. The game uses a small local website server for rooms, bot mode, and live game state.

Important: `http://localhost:3000` is only for your computer. Friends cannot use that address. Friends need the public URL from Render or another web host.

## Make it a website

This project needs a Node server, so deploy it as a web service, not a static site.

Render setup:

1. Put this folder in a GitHub repo and push the latest files.
2. Go to Render and create a new Web Service. Do not create a Static Site.
3. Connect the GitHub repo.
4. Use these settings:

```text
Build Command: npm install
Start Command: npm start
```

5. Health Check Path: `/healthz`
6. Deploy.
7. Render gives you a public URL. Share that URL with your friend.

Both players open the public URL, enter the same room code, and click Join Room.

## If friends get stuck

- Make sure they are opening the public hosted URL, not `localhost`.
- If the host is waking up, wait a few seconds and refresh.
- If a room gets weird, use a new room code.

## Controls

- Move: WASD or arrow keys
- Aim: mouse
- Shoot: click
- Build: Q
