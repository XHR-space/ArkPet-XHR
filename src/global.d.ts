import type { DeskPetApi } from "./types";

declare global {
  interface Window {
    deskPet: DeskPetApi;
  }
}

declare module "*.png" {
  const src: string;
  export default src;
}

export {};
