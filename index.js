import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { request } from "@octokit/request";
import { readFileSync, writeFileSync } from "node:fs";
import cp from "node:child_process";
import nodemailer from "nodemailer";
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

    if (
      config.repository === payload.repository.full_name &&
      (payload.repository.default_branch === payload.ref?.split("/")[2] ||
        payload.repository.default_branch === payload.workflow_run?.head_branch)
    ) {
      try {
        for (const { command, cwd, timeout } of config.commands) {
          if (command === "downloadArtifact") {
            const res = await requestWithAuth(
              "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
              {
                owner: payload.repository.owner.login,
                repo: payload.repository.name,
                run_id: payload.workflow_run.id,
              }
            );
            for (const artifact of res.data.artifacts) {
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
            await exec(command, { cwd, timeout: timeoutInMinutes });
          }
        }
        console.log("All done!");
      } catch (err) {
        console.error(err);
        try {
          const t = await createTransport();
          await t.sendMail({
            from: {
              name: "Minimal CI",
              address: "admin@6v4.de",
            },
            to: config.email,
            subject: "Build failed",
            text: `Build failed at ${new Date().toISOString()}. Please check the logs for more details.`,
          });
        } catch (mailErr) {
          console.error("Could not send failure mail:", mailErr);
        }
        console.error("Build failed");
      }
    }
  });
}

/**
 * Downloads an artifact archive.
 *
 * The GitHub API answers with a 302 to a short-lived, pre-signed Azure Blob
 * URL. That URL carries its own SAS credentials and rejects any request that
 * also sends an `Authorization` header with
 * `403 AuthenticationFailed`, so the redirect has to be followed manually
 * without the token.
 */
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
    // No redirect: the body already is the archive.
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

async function createTransport() {
  return nodemailer.createTransport({
    host: "localhost",
    port: 25,
    tls: {
      servername: "6v4.de",
      // The local relay uses a self-signed certificate.
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
    },
  });
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
