import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { request } from "@octokit/request";
import { readFileSync, writeFileSync } from "node:fs";
import cp from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createServer } from "node:http";

const requestWithAuth = request.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});

const exec = promisify(cp.exec);

const webhooks = new Webhooks({
  secret: process.env.SECRET,
});

const configurations = JSON.parse(
  readFileSync("config.json", { encoding: "utf-8" })
);

for (const config of configurations) {
  webhooks.on(config.on, async ({ payload }) => {
    console.log("Event received!");
    console.log("Repo:", payload.repository.full_name);

    if (config.repository !== payload.repository.full_name) {
      return;
    }

    if (
      payload.repository.default_branch !== payload.ref?.split("/")[2] &&
      payload.repository.default_branch !== payload.workflow_run?.head_branch
    ) {
      return;
    }

    // workflow_run.completed fires for every workflow and every conclusion.
    // Runs that failed, were cancelled or belong to another workflow have no
    // artifacts for us, so skip them instead of running commands that expect one.
    if (payload.workflow_run) {
      if (config.workflow && config.workflow !== payload.workflow_run.name) {
        console.log(`Skipping workflow ${payload.workflow_run.name}`);
        return;
      }
      if (payload.workflow_run.conclusion !== "success") {
        console.log(
          `Skipping workflow run with conclusion ${payload.workflow_run.conclusion}`
        );
        return;
      }
    }

    // Commands inherit the environment pm2 started this process with. That
    // environment can pin an outdated toolchain (e.g. a stale fnm/nvm PATH), so
    // an optional `env` on the config or on a single command overrides it.
    const configEnv = { ...process.env, ...config.env };

    try {
      for (const { command, cwd, timeout, env } of config.commands) {
        if (command === "downloadArtifact") {
          const res = await requestWithAuth(
            "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
            {
              owner: payload.repository.owner.login,
              repo: payload.repository.name,
              run_id: payload.workflow_run.id,
            }
          );
          const artifacts = res.data.artifacts.filter(
            (artifact) =>
              !artifact.expired &&
              (!config.artifact || config.artifact === artifact.name)
          );
          if (artifacts.length === 0) {
            throw new Error(
              `No downloadable artifacts found for run ${payload.workflow_run.id}`
            );
          }
          for (const artifact of artifacts) {
            const zip = await downloadArtifact(
              payload.repository.owner.login,
              payload.repository.name,
              artifact.id
            );
            writeFileSync(resolve(cwd, "build.zip"), zip);
          }
        } else {
          console.log(`Executing ${command} at ${cwd}`);
          const timeoutInMinutes = timeout * 1000 * 60;
          const { stdout, stderr } = await exec(command, {
            cwd,
            timeout: timeoutInMinutes,
            env: { ...configEnv, ...env },
            // Builds are chatty and the 1 MB default kills the child once its
            // output no longer fits.
            maxBuffer: 32 * 1024 * 1024,
          });
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
        }
      }
      console.log("All done!");
    } catch (err) {
      console.error(err);
      console.error("Build failed");
    }
  });
}

// The redirect target is a pre-signed URL that rejects requests carrying an
// Authorization header with 403, so it must be followed without the token.
async function downloadArtifact(owner, repo, artifact_id) {
  const res = await requestWithAuth(
    "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    {
      owner,
      repo,
      artifact_id,
      archive_format: "zip",
      request: { redirect: "manual" },
    }
  );

  const location = res.headers.location;
  if (!location) {
    return Buffer.from(res.data);
  }

  const download = await fetch(location);
  if (!download.ok) {
    throw new Error(
      `Failed to download artifact ${artifact_id}: ${download.status} ${download.statusText}`
    );
  }
  return Buffer.from(await download.arrayBuffer());
}

createServer(
  createNodeMiddleware(webhooks, {
    path: process.env.URLPATH || "/",
    onUnhandledRequest(req, res) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          request: {
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: req.body,
          },
          error: "Unhandled request",
        })
      );
    },
  })
).listen(process.env.PORT || 8080);
