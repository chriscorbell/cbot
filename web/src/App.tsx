import { useEffect, useRef } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { useConfigUI } from './configStore';
import { Presence } from './components/Presence';
import { SignIn } from './components/SignIn';
import { SetupWizard } from './components/SetupWizard';
import { Notices } from './components/Toast';

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const needsSetup = useStore((s) => s.needsSetup);
  const appRef = useRef<HTMLDivElement>(null);

  // The setup wizard covers the app until it is done: nothing under it takes focus, clicks or a screen reader's attention.
  useEffect(() => { appRef.current?.toggleAttribute('inert', needsSetup); }, [needsSetup]);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    st.loadUpdate().catch(console.error);
    return startEvents();
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      // The setup wizard covers the app until it is done.
      if (st.needsSetup) return;
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set({ sidebarExpanded: !st.sidebarExpanded }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Escape closes the sidebar drawer on narrow screens.
  useEffect(() => {
    if (!drawerOpen) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') useStore.getState().set({ drawerOpen: false }); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [drawerOpen]);

  return (
    <div ref={appRef} className={`app${drawerOpen ? ' is-drawer-open' : ''}${detailsOpen && hasBot ? ' has-details' : ''}`}>
      <Sidebar />
      <div className="drawer-scrim" onClick={() => useStore.getState().set({ drawerOpen: false })} aria-hidden />
      <ChatView />
      <Presence show={detailsOpen && hasBot} ms={200}><DetailsPanel /></Presence>
      <Presence show={modal === 'create'}><CreateBotModal /></Presence>
      <Presence show={modal === 'group'}><CreateGroupModal /></Presence>
      <Presence show={modal === 'search'}><SearchModal /></Presence>
      <Presence show={viewerOpen} ms={180}><ComputerViewer /></Presence>
      <ConfigLayer />
      <Notices />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  const needsSetup = useStore((s) => s.needsSetup);
  useEffect(() => { void useStore.getState().checkAuth(); }, []); // checkAuth never rejects: a failure signs out
  if (!authChecked) return <div className="boot" />;
  // The sign-in screen stays over the app while it fades out, so the setup wizard or the chat appears
  // underneath it; the wizard fades the same way into the first bot's chat.
  return (
    <>
      {user && <Shell />}
      <Presence show={!!user && needsSetup} ms={360}><SetupWizard /></Presence>
      <Presence show={!user} ms={280}><SignIn /></Presence>
    </>
  );
}
