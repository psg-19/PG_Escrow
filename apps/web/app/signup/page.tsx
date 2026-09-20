import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { SignupForm } from "@/components/AuthForms";

export default async function SignupPage() {
  if (await api.me()) redirect("/me");
  return (
    <main>
      <SignupForm />
    </main>
  );
}
