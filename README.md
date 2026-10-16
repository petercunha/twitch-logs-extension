# Twitch Chat Logs

A Chrome extension (Manifest V3) that adds a **Chat logs** button to Twitch user cards. Click it to see everything that chatter has said in the channel. The logs come from [Lurkology](https://lurkology.com/logs).

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open any channel on twitch.tv, click a name in chat, and click the speech-bubble icon on the user card.

After editing the code, click the reload icon on the extension card, then refresh your Twitch tabs.

## Usage

- **Click a username** (or an `@mention`) in chat as usual. The user card gets a speech-bubble **Chat logs** icon: on Twitch's card it's next to the close button, and on 7TV's card it's in the icon row. Click it to open the logs panel, which shows the newest messages first.
- **Filter** narrows the months you've loaded. Press **Enter** in the filter to search the user's whole history in the channel.
- **Month picker** jumps to any logged month. Scrolling to the bottom loads older months.
- **Channel box**: edit the channel name and press Enter to look the same user up in another channel.
- Drag the header to move the panel, and drag the bottom-right corner to resize it. **Esc** closes the panel.

It works on channel pages, popout chat (`/popout/<channel>/chat`), embedded chat, Mod View, and the creator dashboard. It also renders Twitch, 7TV, BTTV and FFZ emotes.

## How it works

Lurkology's logs page is a front end for its log aggregator at `bestlogs.lurkology.com`, which pulls from many justlog/rustlog instances. The API is public JSON and sends `Access-Control-Allow-Origin: *`:

| Endpoint | Returns |
| --- | --- |
| `GET /list?channel={c}&user={u}` | `{ availableLogs: [{ year, month }] }`, newest first |
| `GET /channel/{c}/user/{u}/{yyyy}/{m}?jsonBasic=1&reverse=1` | `{ messages: [{ text, displayName, timestamp, id, tags }] }`, newest first |
| `GET /channel/{c}/user/{u}/search?q={q}&jsonBasic=1&reverse=1` | Matches across every month (404 when there are no matches) |

An unknown user or channel gets a `404` with a plain-text reason such as `The user does not exist: foo`. The `tags` are the raw IRC tags, which is where emote positions, `room-id`, and sub/timeout details come from.

## Files

- `src/content.js` watches for Twitch's or 7TV's user card to appear and adds the logs button to it. It reads the login from the card's profile link, works out the channel from the URL, and draws the panel inside a shadow root so Twitch's CSS can't affect it.
- `src/background.js` is the service worker. It makes every network request (logs and emote sets) and caches responses briefly.
- `src/panel.css` holds the panel styles, with dark and light variants that follow Twitch's theme.
- `src/card.css` styles the button added to the user cards.
- `scripts/make_icons.py` regenerates `icons/` using only the Python standard library.
