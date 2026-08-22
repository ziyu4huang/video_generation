export const meta = {
  name: "REPLACE_ME",
  description: "A self-contained workflow pack.",
  phases: [{ title: "Run" }],
};

export default async function ({ agent, log }) {
  const out = await agent("Do the task.", { agentType: "worker" });
  log(out);
  return out;
}
