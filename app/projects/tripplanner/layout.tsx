import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import AppFrame from "../../components/AppFrame";
import "./trip.css";
import { KeyboardAware } from "./_components/KeyboardAware";

const geistSans = localFont({
  src: "./_fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "TripPlanner",
  description: "Turn TikToks, reels and map links into pinned places and a day-by-day trip plan.",
};

export default function TripPlannerLayout({ children }: { children: ReactNode }) {
  return (
    <AppFrame name="TripPlanner" fill>
      <div className={`trip-app ${geistSans.variable} h-full`}>{children}</div>
      <KeyboardAware />
    </AppFrame>
  );
}
