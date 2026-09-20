import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { LoginForm } from "@/components/AuthForms";

export default async function LoginPage() {
  if (await api.me()) redirect("/me");
  return (
    <main>
      <LoginForm />
    </main>
  );
}
