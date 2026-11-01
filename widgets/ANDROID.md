# Android nudge (Tasker)

> Untested recipe. Please open a PR with fixes or a KWGT preset.

1. On your computer, have nudge write `status.json` into a folder that syncs to your phone
   (Google Drive via Autosync, Dropbox, OneDrive or Syncthing):

   ```bash
   nudge schedule <exports> --out "C:\Users\you\Syncthing\nudge"
   ```

2. In **Tasker**:
   * **Profile → Application →** Instagram, TikTok, YouTube
   * **Task**
     1. *File → Read File* → `Sync/nudge/status.json` → to `%status`
     2. *Code → JavaScriptlet*:
        ```js
        var s = JSON.parse(status);
        var headline = s.headline;
        var body = s.top.length ? ("Try: " + (s.top[0].opener || s.top[0].nudge)) : "";
        ```
     3. *Alert → Notify* → Title `%headline`, Text `%body`

You'll get "Maya + 2 others are waiting on you" every time a feed app opens.
