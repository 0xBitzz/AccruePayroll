import { useEffect, useState } from "react";
import { Droplets, ExternalLink, TriangleAlert } from "lucide-react";
import { WalletProvider, useWallet } from "./lib/wallet";
import { TxProvider } from "./lib/tx";
import { fetchMemberships, isDeployed, PAYROLL, usePoll } from "./lib/data";
import { FAUCET_URL, publicClient } from "./lib/chain";
import { payrollAbi } from "./lib/generated";
import { readPreference, savePreference } from "./lib/storage";
import { Backdrop } from "./components/ui";
import { TopBar, type View } from "./components/TopBar";
import { Landing, Footer } from "./components/Landing";
import { Employer } from "./components/Employer";
import { Employee } from "./components/Employee";
import { Toasts } from "./components/Toasts";

function Shell() {
  const { account, wrongNetwork, ensureLitvm, error: walletError } = useWallet();
  const gas = usePoll(account ? () => publicClient.getBalance({ address: account }) : null, [account], 15_000);
  const noGas = !!account && gas.data === 0n;
  const [view, setViewState] = useState<View>(() => readPreference("view") === "employee" ? "employee" : "employer");
  const setView = (v: View) => {
    setViewState(v);
    savePreference("view", v);
  };

  // Use payroll membership to choose the initial view after connecting.
  useEffect(() => {
    if (!account || !isDeployed) return;
    let live = true;
    Promise.all([
      publicClient.readContract({ address: PAYROLL!, abi: payrollAbi, functionName: "orgsOwnedBy", args: [account] }),
      fetchMemberships(account),
    ])
      .then(([owned, memberships]) => {
        if (!live) return;
        if (owned.length === 0 && memberships.length > 0) setViewState("employee");
        else if (owned.length > 0 && memberships.length === 0) setViewState("employer");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [account]);

  return (
    <>
      <Backdrop />
      <TopBar view={view} setView={setView} balance={gas.data} />
      {walletError && (
        <div className="container" style={{ paddingTop: 16 }}>
          <div className="banner" role="alert"><TriangleAlert size={16} /> {walletError}</div>
        </div>
      )}
      {!isDeployed && (
        <div className="container" style={{ paddingTop: 16 }}>
          <div className="banner">
            <TriangleAlert size={16} /> Contracts aren’t deployed yet. Run the deploy script, then <code>npm run sync</code>.
          </div>
        </div>
      )}
      {!account || !isDeployed ? (
        <Landing />
      ) : (
        <main className="container">
          {wrongNetwork && (
            <div className="banner info" style={{ marginBottom: 18 }}>
              <TriangleAlert size={16} />
              <span style={{ flex: 1 }}>Your wallet is on another network. You can browse, but switch to LitVM to sign.</span>
              <button className="btn btn-sm" onClick={() => ensureLitvm().catch(() => {})}>
                Switch network
              </button>
            </div>
          )}
          {noGas && !wrongNetwork && (
            <div className="banner info" style={{ marginBottom: 18 }}>
              <Droplets size={16} />
              <span style={{ flex: 1 }}>
                This wallet has no zkLTC yet. You need a little for gas: each action costs well under 0.001 zkLTC.
              </span>
              <a className="btn btn-sm" href={FAUCET_URL} target="_blank" rel="noreferrer">
                Get zkLTC <ExternalLink size={13} />
              </a>
            </div>
          )}
          {view === "employer" ? <Employer key={account} /> : <Employee key={account} />}
          <Footer />
        </main>
      )}
      <Toasts />
    </>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <TxProvider>
        <Shell />
      </TxProvider>
    </WalletProvider>
  );
}
