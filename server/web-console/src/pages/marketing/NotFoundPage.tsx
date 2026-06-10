import { Link } from "react-router-dom";
import { MarketingLayout } from "./MarketingLayout";

export function NotFoundPage() {
  return (
    <MarketingLayout title="Page not found">
      <section className="lp-section lp-not-found">
        <h1>404</h1>
        <p>That page does not exist.</p>
        <Link to="/" className="lp-btn lp-btn-primary">
          Back to home
        </Link>
      </section>
    </MarketingLayout>
  );
}
