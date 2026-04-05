# Development Guide - Friday Listen UI

## Quick Start

### Option 1: Full Development Mode (Recommended)
Run both backend and frontend with hot reload:

```bash
npm run dev:all
```

This will:
- Start the backend on `http://localhost:3847` with auto-restart on code changes
- Start the frontend dev server on `http://localhost:5173` with hot reload (HMR)
- Open the app at `http://localhost:3847/friday/listen`

**Benefits:**
- ✅ Frontend changes reload instantly (no page refresh needed)
- ✅ Backend auto-restarts on changes
- ✅ See changes immediately while developing
- ✅ Better development experience overall

### Option 2: Backend Only (Production Build)
```bash
npm run start
# Then run build after frontend changes:
npm run ui:build
# And restart the server
```

### Option 3: Frontend Only (Testing UI Changes)
```bash
npm run ui:dev
```
Then open `http://localhost:5173` in your browser.
- **Note:** This won't connect to the real backend API

## Frontend Changes Workflow

When developing the UI:

1. **Start dev mode:**
   ```bash
   npm run dev:all
   ```

2. **Edit React/TypeScript files** in `src/components/` or `src/styles/`

3. **See changes instantly** - Vite's HMR will refresh the browser automatically

4. **No manual restart needed!**

## CSS/Styling Changes

CSS changes are **instantly reflected** thanks to Vite HMR:
- Edit any `.module.css` file
- Changes apply immediately in the browser
- No rebuild or restart required

## Environment

- **Backend:** Node.js with Express on port 3847
- **Frontend Dev Server:** Vite on port 5173
- **Build Output:** `/dist/` directory

## Troubleshooting

**Changes not showing up?**
- Make sure you're using `npm run dev:all`
- Check that both "Backend" and "Frontend" are running (look for colored output)
- Hard refresh the browser (Ctrl+Shift+R)
- Check browser console for errors

**Port already in use?**
- Change frontend port: `vite --port 5174`
- Change backend port: Set `PORT=3848` environment variable

**Need to rebuild for production?**
```bash
npm run ui:build
```

Then deploy the `dist/` folder.

## Development Tips

✅ **Always use `npm run dev:all`** when working on the UI
✅ Keep the terminal window visible to see compilation errors
✅ Use browser DevTools to debug React components
✅ Check network tab for API issues

## File Structure

```
src/
├── components/        # React components
├── contexts/         # React contexts
├── hooks/            # Custom React hooks
├── styles/           # CSS modules
├── data/             # Data files (avatars, personas, etc)
└── server.js         # Backend server
```

## Quick Commands

| Command | Purpose |
|---------|---------|
| `npm run dev:all` | Full dev mode (recommended) |
| `npm run dev` | Backend only with auto-restart |
| `npm run ui:dev` | Frontend only dev server |
| `npm run ui:build` | Build production frontend |
| `npm start` | Run production server |
| `npm test` | Run tests |
