import { redirect } from "next/navigation";

// The app lives at /projects/tripplanner (same paths as on jordialbanell.com, so nothing inside needed rewriting).
export default function Home() {
  redirect("/projects/tripplanner");
}
