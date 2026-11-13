import Layout from "@/components/Layout";
import { SEO } from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { useLatestVersion } from "@/hooks/useLatestVersion";
import { ArrowRight, Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DOCS_URL,
  HUB_COMMAND,
  INSTALL_COMMAND,
  RELEASES_URL,
  REPO_URL,
  RUNNER_COMMAND,
  UPSTREAM_URL,
} from "@/const";

type StateRow = { name: string; meaning: string; action: string };

// Review and Blocked are the states that need the reader; the app shows them in red.
const ATTENTION_ROWS = new Set([3, 4]);

function CommandLine({ command, hint }: { command: string; hint?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-neutral-950 text-neutral-50 px-4 py-3 font-mono text-sm">
      <div className="overflow-x-auto whitespace-nowrap">
        <span className="select-none text-neutral-500">$ </span>
        {command}
        {hint ? <span className="text-neutral-500">{"  # "}{hint}</span> : null}
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-neutral-400 hover:text-white"
        title={copied ? t("install.copied") : t("install.copy")}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Section({ id, children, muted }: { id?: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <section id={id} className={`py-16 md:py-20 ${muted ? "bg-muted/50 border-y border-border" : ""}`}>
      <div className="container">{children}</div>
    </section>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const version = useLatestVersion();
  const rows = t("states.rows", { returnObjects: true }) as StateRow[];
  const alsoItems = t("also.items", { returnObjects: true }) as string[];

  return (
    <Layout>
      <SEO />

      {/* Hero */}
      <section className="pt-16 md:pt-24 pb-12">
        <div className="container">
          <div className="max-w-3xl space-y-6">
            {version ? (
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <span className="h-2 w-2 rounded-full bg-signal" />
                {t("hero.version", { version })}
              </a>
            ) : null}
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.1]">{t("hero.title")}</h1>
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">{t("hero.subtitle")}</p>
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Button size="lg" asChild>
                <a href="#install">
                  {t("hero.start")} <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href={REPO_URL} target="_blank" rel="noreferrer">{t("hero.github")}</a>
              </Button>
            </div>
          </div>

          <div className="mt-12 overflow-hidden rounded-lg border border-border shadow-sm">
            <img src="/images/screenshot-desktop.png" alt={t("hero.screenshotAlt")} className="w-full h-auto dark:hidden" />
            <img src="/images/screenshot-desktop-dark.png" alt={t("hero.screenshotAlt")} className="w-full h-auto hidden dark:block" />
          </div>
        </div>
      </section>

      {/* Task states */}
      <Section muted>
        <div className="max-w-3xl">
          <h2 className="text-3xl font-bold mb-4">{t("states.title")}</h2>
          <p className="text-muted-foreground text-lg mb-8">{t("states.intro")}</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{t("states.colState")}</th>
                <th className="px-4 py-3 font-medium">{t("states.colMeaning")}</th>
                <th className="px-4 py-3 font-medium">{t("states.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.name} className="border-b border-border last:border-0">
                  <td className={`px-4 py-3 font-semibold whitespace-nowrap ${ATTENTION_ROWS.has(index) ? "text-signal" : ""}`}>
                    {row.name}
                  </td>
                  <td className="px-4 py-3">{row.meaning}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 max-w-3xl text-muted-foreground">{t("states.note")}</p>
      </Section>

      {/* Assistant, worktrees, schedules */}
      <Section>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
          <div className="space-y-10">
            <div>
              <h2 className="text-2xl font-bold mb-4">{t("assistant.title")}</h2>
              <p className="text-muted-foreground mb-4">{t("assistant.body1")}</p>
              <p className="text-muted-foreground">{t("assistant.body2")}</p>
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-4">{t("worktrees.title")}</h2>
              <p className="text-muted-foreground">{t("worktrees.body")}</p>
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-4">{t("schedules.title")}</h2>
              <p className="text-muted-foreground">{t("schedules.body")}</p>
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-border shadow-sm">
            <img src="/images/screenshot-task-detail.png" alt={t("worktrees.screenshotAlt")} className="w-full h-auto" />
          </div>
        </div>
      </Section>

      {/* Phone */}
      <Section muted>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div className="max-w-xl">
            <h2 className="text-3xl font-bold mb-4">{t("phone.title")}</h2>
            <p className="text-muted-foreground text-lg">{t("phone.body")}</p>
          </div>
          <div className="flex justify-center gap-4">
            <img
              src="/images/screenshot-phone-tasks.png"
              alt={t("phone.tasksAlt")}
              className="w-[45%] max-w-[260px] rounded-2xl border border-border shadow-sm"
            />
            <img
              src="/images/screenshot-phone-approve.png"
              alt={t("phone.approveAlt")}
              className="w-[45%] max-w-[260px] rounded-2xl border border-border shadow-sm"
            />
          </div>
        </div>
      </Section>

      {/* Also included */}
      <Section>
        <h2 className="text-2xl font-bold mb-6">{t("also.title")}</h2>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-3 max-w-5xl">
          {alsoItems.map((item) => (
            <li key={item} className="flex gap-3 text-muted-foreground">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* Install */}
      <Section id="install" muted>
        <div className="max-w-3xl">
          <h2 className="text-3xl font-bold mb-4">{t("install.title")}</h2>
          <p className="text-muted-foreground mb-8">{t("install.lead")}</p>
          <ol className="space-y-6">
            <li className="space-y-2">
              <h3 className="font-semibold">1. {t("install.step1")}</h3>
              <CommandLine command={INSTALL_COMMAND} />
            </li>
            <li className="space-y-2">
              <h3 className="font-semibold">2. {t("install.step2")}</h3>
              <CommandLine command={HUB_COMMAND} hint={t("install.step2Hint")} />
            </li>
            <li className="space-y-2">
              <h3 className="font-semibold">3. {t("install.step3")}</h3>
              <CommandLine command={RUNNER_COMMAND} hint={t("install.step3Hint")} />
            </li>
          </ol>
          <p className="mt-8">{t("install.open")}</p>
          <p className="mt-4 text-muted-foreground">{t("install.relay")}</p>
          <p className="mt-4 text-muted-foreground">
            {t("install.binary")}{" "}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
              {t("install.releases")}
            </a>
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Button asChild>
              <a href={DOCS_URL}>
                {t("nav.docs")} <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </Section>

      {/* Comparison */}
      <Section>
        <div className="max-w-3xl space-y-4">
          <h2 className="text-2xl font-bold">{t("compare.title")}</h2>
          <p className="text-muted-foreground">{t("compare.body1")}</p>
          <p className="text-muted-foreground">{t("compare.body2")}</p>
          <p className="text-muted-foreground">
            {t("compare.fork")}{" "}
            <a href={UPSTREAM_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
              tiann/hapi
            </a>
          </p>
        </div>
      </Section>
    </Layout>
  );
}
