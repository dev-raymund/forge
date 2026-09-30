import { Suspense } from "react";

export default function SitePage(props: PageProps<"/render/[host]/[[...path]]">) {
  return (
    <Suspense fallback={null}>
      <SitePlaceholder params={props.params} />
    </Suspense>
  );
}

async function SitePlaceholder({ params }: Pick<PageProps<"/render/[host]/[[...path]]">, "params">) {
  const { host, path } = await params;
  return (
    <main>
      <p>
        Site placeholder for <code>{decodeURIComponent(host)}</code> at{" "}
        <code>/{(path ?? []).join("/")}</code>. Rendering arrives in M4–M5.
      </p>
    </main>
  );
}
