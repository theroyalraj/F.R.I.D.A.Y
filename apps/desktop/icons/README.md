# Icons

Generate platform icons from one master PNG (min 1024×1024):

```bash
cd apps/desktop
npm install
npx @tauri-apps/cli icon path/to/app-icon.png
```

This creates `32x32.png`, `icon.icns`, `icon.ico`, etc., expected by `src-tauri/tauri.conf.json`.
