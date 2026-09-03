import { _electron as electron } from "playwright";
import path from "node:path";

const executablePath = process.argv[2];
if (!executablePath) {
  throw new Error("Usage: npm run test:desktop:smoke -- <desktop-executable>");
}

const fixturePath = path.resolve("tests/fixtures/agent-skill-tree.nwk");
const app = await electron.launch({
  executablePath: path.resolve(executablePath),
  args: [fixturePath],
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "1" },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")]
      .find((element) => element.textContent?.trim() === "Download Newick");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 15_000 });
  if (!await page.getByRole("button", { name: "Spiral", exact: true }).isDisabled()) {
    throw new Error("The loaded fixture did not produce the expected 16-tip tree state.");
  }
} finally {
  await app.close();
}
