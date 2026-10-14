import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownAvatarUrl } from "./account-image";

const USER = "0192f000-0000-7000-8000-0000000000c1";
const OTHER = "0192f000-0000-7000-8000-0000000000c2";
const AVATAR = "0192f000-0000-7000-8000-0000000000d1";

describe("the picture shown for a user (M6-2)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.APP_ORIGIN = "https://cms.example.com";
    delete process.env.MEDIA_PUBLIC_BASE_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("their own uploaded avatar, served by /media", () => {
    const url = `https://cms.example.com/media/u/${USER}/a/${AVATAR}/thumb/avatar.webp`;
    expect(ownAvatarUrl({ id: USER, image: url })).toBe(url);
  });

  it("nothing else: none, Google's picture from sign-up, another user's avatar, another host, anything odd", () => {
    for (const image of [
      null,
      "https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c",
      `https://cms.example.com/media/u/${OTHER}/a/${AVATAR}/thumb/avatar.webp`,
      `https://evil.example/media/u/${USER}/a/${AVATAR}/thumb/avatar.webp`,
      `https://cms.example.com/media/u/${USER}/a/${AVATAR}/thumb/avatar.webp?x=" onerror="alert(1)`,
      `javascript:alert(1)//https://cms.example.com/media/u/${USER}/a/`,
    ]) {
      expect(ownAvatarUrl({ id: USER, image }), String(image)).toBeNull();
    }
  });

  it("follows the media base URL when one is configured (a CDN later)", () => {
    process.env.MEDIA_PUBLIC_BASE_URL = "https://media.example.net";
    const url = `https://media.example.net/u/${USER}/a/${AVATAR}/thumb/avatar.webp`;
    expect(ownAvatarUrl({ id: USER, image: url })).toBe(url);
    expect(ownAvatarUrl({ id: USER, image: `https://cms.example.com/media/u/${USER}/a/${AVATAR}/thumb/avatar.webp` })).toBeNull();
  });
});
