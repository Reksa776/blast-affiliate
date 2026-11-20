import { InvitationAcceptance } from "@/components/invitation-acceptance";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const value = query.token;
  const token = typeof value === "string" ? value : "";
  return <InvitationAcceptance token={token} />;
}
