import type { Metadata } from "next";
import { ApiDocumentation } from "./swagger";

export const metadata: Metadata = {
  title: "RS-Key API documentation",
  description: "Interactive OpenAPI documentation for the RS-Key Web Flasher API.",
};

export default function DocsPage() {
  return <ApiDocumentation />;
}
