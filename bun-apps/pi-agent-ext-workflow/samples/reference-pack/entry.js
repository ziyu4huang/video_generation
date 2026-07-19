export const meta = {
  name: "reference-pack",
  description: "Exercises manifest + bundled agents.",
  phases: [{ title: "Research" }, { title: "Write" }],
};

export default async function ({ agent, log }) {
  const research = await agent("Research the topic.", { agentType: "researcher" });
  log(research);
  const draft = await agent("Write up the findings.", { agentType: "writer" });
  return draft;
}
