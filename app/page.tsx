import type { Metadata } from "next";
import { Flasher } from "./flasher";

export const metadata: Metadata = {
  title: "RS-Key Web Flasher",
  description: "Install RS-Key firmware on a compatible Pico device over USB.",
};

export default function Home() {
  return <Flasher />;
}
