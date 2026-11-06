# Emberline

**A live ribbon for Claude Code. See what your session is doing, what it costs, and keep its context warm while you are away.**

<!-- Add a screenshot here: ![Emberline](docs/ribbon.png) -->

Claude's prompt cache expires an hour after the last request. Come back later and the next message rewrites the whole conversation at full price, or the app swaps your context for a summary. Emberline shows you that clock, and can hold it open for you.

## What it shows

**The ribbon**
- Usage left in each limit window, with reset times.
- Context tokens and share of the window, with a small colour bar of what fills it.
- Cache WARM or COLD, with a countdown and the share of the last request the cache really served.
- The session's running cost at list price, when the row has room.

**The upper row**
- The current step of the task list, a step count and a rough time left.
- Running subagents, connector calls and shell commands past 5 seconds.
- Background work, added when a turn ends.

**Behind `ⓘ`**
- Each context category with its tokens and share, counted locally with no API call.
- Idle time, tokens in cache, and what the next message costs on each model.

**On request**
- An Agents panel (`/agents-panel`) with each subagent's model, time, tokens and estimated cost.
- A notification before the cache goes cold, for sessions over 100k tokens.

## Keep-warm

Pick 2h, 6h or 12h on the ribbon, or run `/keep-warm 1h` to `12h`, `off` or `ping`.

- 50 minutes after the last request, one small side request reads the cached conversation and resets the hour.
- It leaves no row in your conversation.
- While it holds, it also skips the app's idle compaction, so your full context stays. Compaction at the context limit still runs.
- It is off by default, per session. With it off, Emberline never calls a model.
- It stops at the time you picked, at `/clear`, or as soon as a ping errors or misses the cache.

**Measured on a real 413k session:** after 75 idle minutes, the first request read 412,966 tokens from cache and wrote 680. One ping cost about $0.08 at Opus list price, against about $3.30 to rewrite the context. That is one run, and your numbers will differ.

**Know before you use it**
- Pings are real requests and count against your usage. Roughly 33 hours of pings on Opus cost as much as one rewrite, so it pays for gaps of hours, not days.
- The timer lives in the running session, so the computer must stay awake and the app open.

## Install

At the prompt of a terminal session:

```
/plugin install emberline --marketplace kskarakostas/claude-ribbon-emberline
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `kskarakostas/claude-ribbon-emberline`, then Add plugin.

The task-step row reads the desktop app's task list, so it shows there only. Costs are list-price estimates, not a bill.

## Develop

```
claude plugin test .
claude plugin validate .
```

## Credits

Built by K. S. Karakostas with Claude Code. The cache card, Robo and the usage bars began as [ribbon](https://github.com/robonuggets/ribbon) by RoboNuggets, and agent tracking as [savvy-progress](https://github.com/JohnnyVizz/claude-kit) by johnnyvizz. Both are MIT; see [THIRD_PARTY.md](THIRD_PARTY.md), which also covers the embedded Outfit font.

MIT License.
