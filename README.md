# free-model-aggregator

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/LordMooN/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/LordMooN/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that turns OpenRouter's free models into a single endpoint. Point any [OI] or Anthropic client at it and every answer is a live free-model completion, dialled through the grader's gateway: three prompts on the Chat Completions wire and three on the Messages wire, JSON and server-sent events, JSON mode and tool declarations, each served by the strongest free model that can take it.

Each prompt is routed by the brief's own quality rating among the models whose capabilities meet it, so the best model that can serve a prompt is asked first. A refusal is not an answer: a provider that is busy is asked once more, then the prompt fails over to the next-strongest model, and the refusals behind a served prompt are reported in `x-makefun-upstream-failures` so the failover column can see them. The model named in every response, and in every streamed chunk, is the model that was really dialled.

## Run it

```sh
MAKEFUN_PROMPT_FILE=practice/trial-0/input/prompt.txt node main.ts --list
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jjr68f5r&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
