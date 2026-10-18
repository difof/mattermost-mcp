import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(script, input, closeInput = true) {
  const source = `import { prompt, promptSecret, select } from ${JSON.stringify(new URL("./prompt.js", import.meta.url).href)};\n${script}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 2000);
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    if (closeInput) child.stdin.end(input);
    else child.stdin.write(input);
  });
}

describe("piped CLI prompts", () => {
  it("retains buffered answers across normal, secret, and selection prompts", async () => {
    const result = await run(
      `const name = await prompt("Name: ");
       const secret = await promptSecret("Secret: ");
       const choice = await select("Mode", [{label:"A",value:"a"},{label:"B",value:"b"}]);
       const last = await prompt("Last: ");
       console.log(JSON.stringify({name,secret,choice,last}));`,
      "  Alice  \n  dummy secret  \n2\nfinished\n",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: "Alice",
      secret: "  dummy secret  ",
      choice: "b",
      last: "finished",
    });
    expect(result.stderr).not.toContain("dummy secret");
  });

  it("aborts on EOF when another answer is required", async () => {
    const result = await run('await prompt("First: "); await prompt("Missing: ");', "one\n");
    expect(result.status).toBe(130);
    expect(result.stderr).toContain("Aborted.");
  });

  it("exits after the last answer even if the producer keeps stdin open", async () => {
    const result = await run('console.log(await prompt("Answer: "));', "done\n", false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("done");
  });
});
