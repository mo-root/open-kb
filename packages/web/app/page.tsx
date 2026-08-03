import { BuildWorkflow } from "@/components/build/BuildWorkflow";

/* The map page. The run surface itself is a client component — it holds five
   live NDJSON readers — so this stays a thin server shell around it. */

export default function Home() {
  return <BuildWorkflow />;
}
