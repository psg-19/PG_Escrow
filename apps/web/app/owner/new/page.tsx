import Link from "next/link";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { NewListingForm } from "@/components/Forms";

export default async function NewListingPage() {
  const me = await api.me();

  if (!me) redirect("/login");

  if (me.role !== "OWNER") {
    return (
      <main>
        <h1>List a property</h1>
        <div className="card">
          <p style={{ margin: 0 }}>
            This account is registered as a tenant, so it cannot list property.
            Listing needs an owner account.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <Link href="/me" className="back">
        &larr; My properties
      </Link>
      <h1>List a property</h1>
      <p className="lede">
        Tenants will see the rooms and the deposit. What you record in the
        inventory is what any future deduction gets measured against.
      </p>
      <NewListingForm />
    </main>
  );
}
