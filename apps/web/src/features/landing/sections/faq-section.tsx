import { cn } from "@openrail/ui";
import { useState } from "react";
import { FAQ } from "../content";
import { useMediaQuery } from "../hooks";
import { Section } from "../ui";

/**
 * "Plain answers": questions on the left, the selected answer large on the right. On a phone
 * each answer opens under its question instead.
 *
 * @returns The section.
 */
export function FaqSection() {
  const [selected, setSelected] = useState(0);
  const wide = useMediaQuery("(min-width: 1024px)");
  const answer = FAQ[selected];

  return (
    <Section
      id="faq"
      labelledBy="faq-title"
      className="grid gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]"
    >
      <div className="lg:col-span-5">
        <h2 id="faq-title" className="lp-heading" data-reveal>
          Plain answers
        </h2>
        <ul className="mt-10 grid gap-1" data-reveal>
          {FAQ.map((entry, index) => {
            const isSelected = index === selected;
            return (
              <li key={entry.question}>
                <button
                  type="button"
                  aria-expanded={isSelected}
                  aria-controls={wide ? "faq-answer" : `faq-answer-${index}`}
                  onClick={() => setSelected(index)}
                  onPointerEnter={() => wide && setSelected(index)}
                  onFocus={() => wide && setSelected(index)}
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer items-center gap-4 rounded-md py-2 text-left text-[19px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full transition-colors",
                      isSelected ? "bg-accent" : "bg-muted-foreground/50",
                    )}
                  />
                  {entry.question}
                </button>
                {!wide && isSelected ? (
                  <p
                    id={`faq-answer-${index}`}
                    className="lp-fade pb-4 pl-6 text-[18px] leading-relaxed text-foreground"
                  >
                    {entry.answer}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      {wide && answer ? (
        <div className="lg:col-span-6 lg:col-start-7">
          <div
            className="sticky top-[calc(var(--lp-header-h)+32px)]"
            id="faq-answer"
            aria-live="polite"
          >
            <p
              key={answer.question}
              className="lp-fade max-w-[30ch] text-[26px] leading-[1.3] tracking-[-0.01em] text-foreground"
            >
              {answer.answer}
            </p>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
