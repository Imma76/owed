import { connection } from "next/server";
import { recentActivity } from "@/lib/db";

export async function GET() {
  await connection(); // always read fresh: never prerender or cache this route
  return Response.json({ activity: recentActivity(25) });
}
