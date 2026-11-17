import { handleSchedule } from "@vercel/schedules";
import { runCloudScan } from "../lib/scanner.mjs";

export const POST = handleSchedule(async (metadata) => {
  try {
    console.log(
      `Schedule ${metadata.name} (exec=${metadata.executionId}) firing at ${metadata.scheduledAt.toISOString()}`
    );
    const result = await runCloudScan({
      trigger: "scheduled",
      executionId: metadata.executionId,
    });
    console.log("Scheduled scan completed:", JSON.stringify(result));
  } catch (err) {
    console.error("Scheduled scan failed:", err);
    throw err;
  }
});
