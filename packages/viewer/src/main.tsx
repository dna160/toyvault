import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./index.css";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import { Layout } from "./components/Layout";
import { Empty, Loading } from "./components/ui";
import { Unauthorized, api } from "./lib/api";
import { Batches } from "./pages/Batches";
import { Locations } from "./pages/Locations";
import { Login } from "./pages/Login";
import { Review } from "./pages/Review";
import { Search } from "./pages/Search";
import { Unit } from "./pages/Unit";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (n, err) => !(err instanceof Unauthorized) && n < 2,
    },
  },
});

function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false, staleTime: Infinity });
  if (me.isPending) return <Loading />;
  if (me.isError) {
    if (me.error instanceof Unauthorized) return <Login onDone={() => client.invalidateQueries()} />;
    return <Empty title="Can’t reach ToyVault">{(me.error as Error).message}</Empty>;
  }
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Search} />
        <Route path="/units/:id">{(p) => <Unit id={p.id} />}</Route>
        <Route path="/locations" component={Locations} />
        <Route path="/batches" component={Batches} />
        <Route path="/review/:kind?">{(p) => <Review kind={p.kind} />}</Route>
        <Route>
          <Empty title="Page not found" />
        </Route>
      </Switch>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
