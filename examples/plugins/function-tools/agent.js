// This module runs in QuickJS. Bundle third-party dependencies; Node globals are unavailable.
export default {
  activate(ctx) {
    const statistics = (text) => ({
      label: ctx.config.label,
      characters: Array.from(text).length,
      words: text.trim() ? text.trim().split(/\s+/u).length : 0,
      lines: text ? text.split(/\r?\n/u).length : 0,
    });
    ctx.tools.register({
      name: "word_count", description: "Count characters, whitespace-separated words and lines in text.",
      parameters: { type: "object", properties: { text: { type: "string", maxLength: 100000 } }, required: ["text"], additionalProperties: false },
      effects: [], execute: ({ text }) => statistics(text),
    });
    ctx.tools.register({
      name: "file_stats", description: "Read a text file through the shared approval gate and count its contents.",
      parameters: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } }, required: ["path", "reason"], additionalProperties: false },
      effects: ["filesystem.read"],
      async execute({ path, reason }) { return statistics(await ctx.fs.read(path, reason)); },
    });
    ctx.commands.register({
      name: "count", description: "Count text without a model request.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      effects: [], execute: ({ text }) => statistics(text),
    });
    ctx.events.on("turn.finished", async () => {
      const count = await ctx.storage.get("turn-count");
      await ctx.storage.set("turn-count", Number(count || 0) + 1);
    });
    ctx.effect(() => ctx.log("Text tools disposed"));
  },
};
