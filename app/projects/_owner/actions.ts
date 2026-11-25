"use server";

import { refresh } from "next/cache";
import { passwordMatches, signIn, signOut } from "@/lib/owner";

export type SignInState = { error?: string };

export async function signInAction(_prev: SignInState, form: FormData): Promise<SignInState> {
  const pw = String(form.get("password") ?? "");
  if (!passwordMatches(pw)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return { error: "That's not it." };
  }
  await signIn();
  refresh();
  return {};
}

export async function signOutAction() {
  await signOut();
  refresh();
}
