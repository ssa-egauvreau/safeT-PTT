import { useState } from "react";
import faq from "../../data/marketing/faq.json";
import { MarketingLayout } from "./MarketingLayout";

export function FaqPage() {
  const [open, setOpen] = useState<number | null>(0);
  const categories = [...new Set(faq.map((item) => item.category))];

  return (
    <MarketingLayout title="FAQ" description="Frequently asked questions about safeT PTT.">
      <section className="lp-section">
        <div className="lp-section-head">
          <span className="lp-kicker">FAQ</span>
          <h1>Questions &amp; answers</h1>
        </div>
        {categories.map((cat) => (
          <div key={cat} className="faq-category">
            <h2>{cat}</h2>
            <div className="faq-list">
              {faq
                .map((item, idx) => ({ ...item, idx }))
                .filter((item) => item.category === cat)
                .map((item) => (
                  <details
                    key={item.q}
                    className="faq-item"
                    open={open === item.idx}
                    onToggle={(e) => {
                      if ((e.target as HTMLDetailsElement).open) {
                        setOpen(item.idx);
                      }
                    }}
                  >
                    <summary>{item.q}</summary>
                    <p>{item.a}</p>
                  </details>
                ))}
            </div>
          </div>
        ))}
      </section>
    </MarketingLayout>
  );
}
