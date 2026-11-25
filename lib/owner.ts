// Server-only: "is this the owner?" for apps on /projects that let the owner write.
// One shared password (PROJECTS_OWNER_PASSWORD) sets a signed, httpOnly cookie for 30 days.
// Visitors can look; only the owner can add, edit or delete.
import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "ja_owner";
const DAYS = 30;

function secret() {
  const s = process.env.PROJECTS_OWNER_SECRET;
  if (!s) throw new Error("PROJECTS_OWNER_SECRET not set");
  return s;
}

const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");

function same(a: string, b: string) {
  // Compare fixed-length digests so neither length nor content leaks through timing.
  const h = (s: string) => createHmac("sha256", "cmp").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export async function isOwner(): Promise<boolean> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return false;
  await connection(); // the expiry check reads the clock, so this part always runs at request time
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return same(sign(exp), sig);
}

export function passwordMatches(input: string): boolean {
  const real = process.env.PROJECTS_OWNER_PASSWORD;
  if (!real || !input) return false;
  return same(input, real);
}

export async function signIn() {
  const exp = String(Date.now() + DAYS * 86_400_000);
  (await cookies()).set(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: DAYS * 86_400,
  });
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}
