import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  buildCommand: "npm run build",
  cloudflare: {
    useWorkerdCondition: false,
  },
});