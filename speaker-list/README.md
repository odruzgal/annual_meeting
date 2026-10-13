# Speaker List

Runs elections for the men's glee club. Phones join over wifi, the chair drives from a laptop, the laptop screen goes on the projector.

## Running it

Needs Node 18 or newer. No dependencies, no install step.

```
node server.js
```

The terminal prints the address phones should open. Something like:

```
  Projector / admin   http://localhost:3000/admin.html
  Admin PIN           2468

  Phones on the same wifi open:
      http://192.168.1.24:3000
```

Put `admin.html` on the projector. Read the other address out to the room.

To change the PIN or port:

```
ADMIN_PIN=1379 PORT=8080 node server.js
```

## Crash recovery

The meeting is saved to `meeting-state.json` after every change. If the server
stops for any reason — the terminal closes, Node crashes, the laptop restarts —
just run `node server.js` again in the same folder. It picks up exactly where it
left off: the roster, the running order, who has spoken, everyone's remaining
time, and the rebuttal queue all come back. Phones reconnect on their own.

The one deliberate exception is the clock. Whoever had the floor comes back
**paused** at the time they had left, because no one was actually speaking during
the outage — press Resume when the room is ready. The startup message tells you
who it was.

**Reset** wipes the saved meeting and starts clean, so there is nothing to clear
by hand between meetings.

To keep the Mac from sleeping mid-meeting (which freezes the server), launch it
with `caffeinate`:

```
caffeinate -i node server.js
```

That holds sleep off only while the server is running, then releases it.

## Getting 100 phones to reach it (over the internet)

University wifi almost always blocks devices from seeing each other, so the
local `192.168...` address won't work for a room. There are two ways around it.
If your campus firewall also blocks tunnels (cloudflared failing with "port 7844
blocked" or "context deadline exceeded" is the sign), use option A — it avoids
the laptop-as-server entirely and is the most reliable.

### Option A — host it in the cloud (recommended)

Instead of running the server on your laptop and tunnelling to it, you put the
server on a free cloud host. It gets a permanent public address. Phones open it
over cellular or any wifi; your laptop just opens that same address to show the
projector. Nothing has to punch through the campus firewall, because every
connection is ordinary outbound HTTPS — the same thing your browser already does.

Using Render's free tier (all point-and-click, no terminal):

1. **Put the code on GitHub.** Make a free account at github.com, click **New
   repository**, name it `speaker-list`, and on the next page choose **uploading
   an existing file**. Drag in `server.js`, `package.json`, the `public` folder,
   and `README.md`. Commit.
2. **Deploy on Render.** Make a free account at render.com, click **New → Web
   Service**, and connect the GitHub repo you just made. Render reads
   `package.json` and fills in the rest (build command blank, start command
   `npm start`). Pick the **Free** instance type and create it.
3. Set the PIN: under the service's **Environment**, add a variable `ADMIN_PIN`
   with a number of your choosing. (Optional but wise, since the address is
   public.)
4. After a minute Render shows a link like `https://speaker-list-xxxx.onrender.com`.
   **That is your permanent link** — it does not change between meetings.

Then: email that link to the members, and open it **+ `/admin.html`** on the
projector. Done. To update the app later, upload the changed files to GitHub and
Render redeploys on its own.

Two caveats on the free tier: the service "sleeps" after 15 minutes with nobody
connected, so the very first visit after a quiet spell takes ~30 seconds to wake
— open the admin page a minute before the meeting to warm it up. And a free
instance keeps the meeting in memory; if Render restarts it mid-meeting (rare),
the in-progress meeting resets. For a normal meeting neither bites. If you want
it bulletproof, Render's cheapest paid instance removes both.

### Option B — a tunnel from your laptop (if the firewall allows it)

This keeps the server on your laptop and exposes it with a free tool,
`cloudflared`. It only works if your network allows cloudflared's outbound ports
(UDP/TCP 7844) — many campus networks don't, in which case use Option A.

**One-time install** (Mac, in Terminal):

```
brew install cloudflared
```

If that says `command not found: brew`, install Homebrew first from brew.sh,
then run the line above. (No Homebrew? Download cloudflared from
github.com/cloudflare/cloudflared/releases — the `cloudflared-darwin-*.tgz` for
your chip, unzip it, and you'll have the `cloudflared` program.)

**Every meeting — two terminals:**

1. Terminal 1, start the app as usual:
   ```
   node server.js
   ```
2. Terminal 2, open the tunnel:
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
   It prints a line like `https://brave-glee-club-7421.trycloudflare.com`. That
   is your public link.

**Email that link to everyone.** Send the `https://...trycloudflare.com` link to
all the members — that's how they join, straight from their email, on any
network. The join is completely separate from the projector.

**Put the admin page on the projector.** Open the same link **plus `/admin.html`**
in your browser — for example
`https://brave-glee-club-7421.trycloudflare.com/admin.html` — and drag it to the
projector. During sign-ups it shows a running count of how many have joined; it
never shows the link or anything members need to type. The header also displays
the link, which is a handy place to copy it from when you compose the email.

A few things worth knowing:

- The link is new every time you run `cloudflared`, and it stops working when you
  close Terminal 2. Start the tunnel, grab the link, email it, and leave that
  window open for the whole meeting. (Because it changes each run, email it at
  the start of the meeting, not days ahead.)
- Because the link is public, change the PIN from the default so a stray visitor
  can't take the chair: run the app with `ADMIN_PIN=xxxx node server.js` (pick
  your own number). The PIN is never shown on the projector.

## The rules it enforces

**Speaking time.** One minute per person, spent across two passes of the list. Stopping early banks the rest. Whatever is left when the second pass ends is gone.

**Rebuttal time.** One minute per person, separate from speaking, no fixed place in the schedule. Split it across as many turns as you want. It survives past the end of the main list.

**Order.** Shuffled once when the meeting starts. Everyone can see the whole order on their phone.

**Rebuttals interrupt nobody.** A request waits in a first-come queue and is served the moment the floor clears. The queue drains completely before the main list resumes.

**Passing defers, it does not forfeit.** Pass on the first round and you keep your full minute for the second. Pass on the second round and it is gone.

## Running a meeting

1. Start the server. Sign-ups open automatically and the projector shows the join address.
2. Once names are in, type the PIN and press **Start meeting**. The order shuffles and the first speaker's clock starts.
3. Speakers tap **Stop my time** when they finish. If someone's phone dies, press **Next speaker** yourself.
4. **Pause clock** freezes the current turn without ending it — for points of order, or when the room needs settling.
5. **End meeting** closes the floor. **Reset** wipes everything and reopens sign-ups.

## Fixing mistakes mid-meeting

**Roster & time** in the bottom bar opens a panel on the right. The clock stays visible while it's open.

Each person has a row with their speaking and rebuttal time. You can:

- Nudge either budget by 15 seconds with **−15** / **+15**
- Type an exact value — `0:45`, `45`, and `1:30` all work
- Snap back to **Full minute**
- Remove someone with the **×**

Edits to whoever is currently on the floor take effect on the live clock immediately, and it keeps draining from the new number. So if you notice their clock was left running from the last turn, you can give the time back while they're still speaking.

Removing the person on the floor passes the floor to whoever is next.

Escape cancels a field you're editing. Escape again, clicking outside, or **Close** shuts the panel.

The panel needs the PIN, same as the other controls. It tells you if it's missing rather than ignoring your clicks.

## Testing

```
node test.js
```

Spins up a server on port 3999 and walks the whole state machine: banking, FIFO ordering, rebuttal priority, cycle rollover, time expiry, and PIN checks.

## Files

```
server.js           state machine, timing, SSE broadcast, crash recovery
package.json        how a cloud host runs it (npm start)
public/admin.html   projector + chair controls
public/index.html   phone view
test.js             state machine checks
check.py            browser checks for the roster panel (needs playwright)
```

## Notes

Time is kept on the server. Phones and the projector render a countdown locally between updates and correct for clock skew, so a laggy phone shows the same number as the projector.

There is one meeting at a time. Anyone who opens the address joins that meeting. The PIN is the only thing separating the chair's controls from everyone else's, so it only needs to be strong enough to stop a bored tenor.
