const { useState, useEffect, useMemo } = React;

// --- ICONS ---
// Assuming Lucide is loaded globally via script tag: <script src="https://unpkg.com/lucide@latest"></script>
// We map them to React components if needed, or just use `lucide.icons.X`
// Ideally we use lucide-react via UMD, but standard lucide UMD exposes `lucide.createElement(lucide.icons.X)`
// For simplicity with React via CDN, we can create simple wrappers if lucide-react isn't available.
// Let's assume we use standard lucide.createIcons() or just SVG strings?
// Actually, `lucide-react` UMD exports components directly if we find the right CDN.
// Easier approach: Use a helper to render Lucide icons from the global `lucide` object.

const Icon = ({ name, size = 20, className = "" }) => {
    const iconData = lucide.icons[name];
    if (!iconData) return null;

    // Lucide icons are defined as [tag, attrs, children]
    // We can just render standard SVGs using the data
    // OR simpler: use `lucide.createIcons()` logic manually? No, that's for DOM.
    // We can just use the SVG string? No.
    // Let's assume we use a simple set of SVGs inline to be safe and 100% robust without external dep quirks.
    // NO, the user said "be creative", I want lots of icons.
    // I will use `lucide-react` UMD if I can, otherwise I will map the `lucide.icons` to React elements.

    // Check if lucide.icons exists (standard library)
    if (window.lucide && window.lucide.icons) {
        const [tag, attrs, children] = window.lucide.icons[name];
        // This structure is internal to lucide, might be brittle.
        // BETTER: Just use feather icons or similar simple SVG components inline for the critical ones.
        // OR: Use `lucide.createElement` if available.
    }

    // Fallback: Inline SVGs for critical icons to guarantee they work.
    if (name === 'Search') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>;
    if (name === 'X') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
    if (name === 'Filter') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>;
    if (name === 'ChevronRight') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m9 18 6-6-6-6"/></svg>;
    if (name === 'ChevronDown') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m6 9 6 6 6-6"/></svg>;
    if (name === 'Activity') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>;
    if (name === 'Shield') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>;
    if (name === 'FileText') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>;
    if (name === 'Share2') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>;
    if (name === 'Info') return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>;

    return null;
};

// --- MODAL COMPONENT ---
const Modal = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between p-6 border-b border-slate-800">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        {title}
                    </h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
                        <Icon name="X" size={24} />
                    </button>
                </div>
                <div className="overflow-y-auto p-6 custom-scrollbar">
                    {children}
                </div>
            </div>
        </div>
    );
};

// --- INTERACTION CARD COMPONENT ---
const InteractionCard = ({ interaction, onShowEvidence }) => {
    const isDirect = interaction.type === 'direct' || interaction.interaction_type === 'direct';
    const isShared = interaction.type === 'shared';
    const confidence = interaction.confidence || 0.5;

    // Determine color theme based on effect/arrow
    const arrow = (interaction.arrow || 'binds').toLowerCase();
    let themeColor = 'purple';
    if (arrow.includes('activat') || arrow.includes('stimulat')) themeColor = 'green';
    else if (arrow.includes('inhibit') || arrow.includes('block')) themeColor = 'red';

    const borderColor = {
        green: 'border-green-500/30 hover:border-green-500/60',
        red: 'border-red-500/30 hover:border-red-500/60',
        purple: 'border-purple-500/30 hover:border-purple-500/60'
    }[themeColor];

    const bgGradient = {
        green: 'from-green-500/5 to-transparent',
        red: 'from-red-500/5 to-transparent',
        purple: 'from-purple-500/5 to-transparent'
    }[themeColor];

    const textColor = {
        green: 'text-green-400',
        red: 'text-red-400',
        purple: 'text-purple-400'
    }[themeColor];

    return (
        <div className={`group relative bg-slate-800/50 border ${borderColor} rounded-xl p-5 transition-all duration-300 hover:shadow-xl hover:shadow-${themeColor}-500/10 hover:-translate-y-1`}>
            {/* Background Gradient */}
            <div className={`absolute inset-0 bg-gradient-to-br ${bgGradient} rounded-xl opacity-0 group-hover:opacity-100 transition-opacity`} />

            {/* Header */}
            <div className="relative flex justify-between items-start mb-4">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-lg font-bold text-white group-hover:text-cyan-300 transition-colors">
                            {interaction.target}
                        </h3>
                        {isDirect && <span className="px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-cyan-200 bg-cyan-900/50 border border-cyan-700 rounded uppercase">Direct</span>}
                        {isShared && <span className="px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-purple-200 bg-purple-900/50 border border-purple-700 rounded uppercase">Shared</span>}
                    </div>
                    <div className={`text-sm font-medium ${textColor} flex items-center gap-1.5`}>
                        <Icon name="Activity" size={14} />
                        <span className="capitalize">{interaction.interaction_effect || arrow}</span>
                    </div>
                </div>

                {/* Confidence Ring */}
                <div className="flex flex-col items-end">
                    <div className="text-xs text-slate-400 font-mono mb-0.5">Confidence</div>
                    <div className="flex items-center gap-1">
                        <div className="h-1.5 w-12 bg-slate-700 rounded-full overflow-hidden">
                            <div className={`h-full bg-${themeColor}-500`} style={{ width: `${confidence * 100}%` }} />
                        </div>
                        <span className="text-xs font-bold text-slate-300">{Math.round(confidence * 100)}%</span>
                    </div>
                </div>
            </div>

            {/* Functions/Mechanism */}
            <div className="relative mb-4 space-y-2">
                {interaction.functions && interaction.functions.length > 0 ? (
                    interaction.functions.slice(0, 2).map((fn, idx) => (
                        <div key={idx} className="text-sm text-slate-300 bg-slate-900/50 px-3 py-2 rounded border border-slate-700/50">
                            {fn.function}
                        </div>
                    ))
                ) : (
                    <div className="text-sm text-slate-500 italic px-3 py-2">No specific function mapped</div>
                )}
            </div>

            {/* Footer Actions */}
            <div className="relative flex justify-between items-center mt-auto pt-4 border-t border-slate-700/50">
                <div className="flex items-center gap-4 text-xs text-slate-400">
                    <div className="flex items-center gap-1" title="Evidence count">
                        <Icon name="FileText" size={14} />
                        <span>{interaction.evidence ? interaction.evidence.length : 0}</span>
                    </div>
                    <div className="flex items-center gap-1" title="PMID count">
                        <Icon name="Share2" size={14} />
                        <span>{interaction.pmids ? interaction.pmids.length : 0}</span>
                    </div>
                </div>

                <button
                    onClick={() => onShowEvidence(interaction)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-colors border border-slate-600 hover:border-slate-500"
                >
                    View Evidence
                    <Icon name="ChevronRight" size={12} />
                </button>
            </div>
        </div>
    );
};

// --- SIDEBAR TREE ITEM ---
const PathwayTreeItem = ({ node, level = 0, selectedPathways, onToggle }) => {
    const [isExpanded, setIsExpanded] = useState(level < 1);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedPathways.has(node.id);

    return (
        <div className="select-none">
            <div
                className={`
                    flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer transition-colors
                    ${isSelected ? 'bg-cyan-900/30 text-cyan-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}
                `}
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                onClick={() => onToggle(node.id)}
            >
                <button
                    onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                    className={`p-0.5 rounded hover:bg-slate-700/50 ${hasChildren ? 'opacity-100' : 'opacity-0'}`}
                >
                    {isExpanded ? <Icon name="ChevronDown" size={14} /> : <Icon name="ChevronRight" size={14} />}
                </button>

                <span className="text-sm truncate flex-1">{node.name}</span>

                {node.count > 0 && (
                    <span className="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-500">
                        {node.count}
                    </span>
                )}
            </div>

            {hasChildren && isExpanded && (
                <div className="border-l border-slate-800 ml-[15px]">
                    {node.children.map(child => (
                        <PathwayTreeItem
                            key={child.id}
                            node={child}
                            level={level + 1}
                            selectedPathways={selectedPathways}
                            onToggle={onToggle}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

// --- MAIN DASHBOARD APP ---
const Dashboard = () => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [selectedPathways, setSelectedPathways] = useState(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [filterType, setFilterType] = useState('all'); // all, direct, shared
    const [modalInteraction, setModalInteraction] = useState(null);

    useEffect(() => {
        // Load data from global window.SNAP
        if (window.SNAP) {
            console.log("Loading SNAP data:", window.SNAP);

            // Process data for easy consumption
            const rawData = window.SNAP;
            let processed = {
                main: rawData.main || rawData.snapshot_json?.main || 'Unknown',
                interactions: rawData.interactions || rawData.snapshot_json?.interactions || [],
                pathwayTree: [] // Need to build this
            };

            // Build Pathway Tree from interactions if explicit hierarchy is missing
            // V2 pipeline usually stamps 'step3_finalized_pathway' on interactions
            const pathwayMap = new Map();
            const rootPathways = [];

            // Naive tree builder from interaction metadata
            processed.interactions.forEach(ix => {
                const pathway = ix.step3_finalized_pathway || ix.pathway || 'Uncategorized';
                // Split by hierarchy delimiter if exists (assuming "Parent > Child")
                // Or just flat for now if no hierarchy data found
                if (!pathwayMap.has(pathway)) {
                    pathwayMap.set(pathway, { id: pathway, name: pathway, count: 0, children: [] });
                    rootPathways.push(pathwayMap.get(pathway));
                }
                pathwayMap.get(pathway).count++;
            });

            // Sort by count
            rootPathways.sort((a, b) => b.count - a.count);
            processed.pathwayTree = rootPathways;

            setData(processed);
            setLoading(false);
        } else {
            console.error("No SNAP data found!");
            setLoading(false);
        }
    }, []);

    // Filter interactions
    const filteredInteractions = useMemo(() => {
        if (!data) return [];

        return data.interactions.filter(ix => {
            // Search filter
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                const matchesTarget = ix.target?.toLowerCase().includes(q);
                const matchesFunc = ix.functions?.some(f => f.function.toLowerCase().includes(q));
                if (!matchesTarget && !matchesFunc) return false;
            }

            // Type filter
            if (filterType === 'direct' && ix.type !== 'direct') return false;
            if (filterType === 'shared' && ix.type !== 'shared') return false;

            // Pathway filter
            if (selectedPathways.size > 0) {
                const p = ix.step3_finalized_pathway || ix.pathway || 'Uncategorized';
                if (!selectedPathways.has(p)) return false;
            }

            return true;
        });
    }, [data, searchQuery, filterType, selectedPathways]);

    const togglePathway = (id) => {
        const newSet = new Set(selectedPathways);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedPathways(newSet);
    };

    if (loading) return <div className="flex items-center justify-center h-screen text-cyan-400">Initializing Neural Interface...</div>;
    if (!data) return <div className="flex items-center justify-center h-screen text-red-400">Error: No data loaded.</div>;

    return (
        <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">

            {/* LEFT SIDEBAR - PATHWAYS */}
            <div className="w-80 border-r border-slate-800 bg-slate-900/50 flex flex-col backdrop-blur-sm">
                <div className="p-4 border-b border-slate-800">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white font-bold shadow-lg shadow-cyan-500/20">
                            P
                        </div>
                        <h1 className="font-bold text-lg tracking-tight text-white">ProPath <span className="text-cyan-400 text-xs font-normal ml-1">v2.0</span></h1>
                    </div>
                    <p className="text-xs text-slate-500">Interactive Molecular Dashboard</p>
                </div>

                <div className="p-4 border-b border-slate-800 bg-slate-900/30">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Pathways</h3>
                    {/* Pathway Tree */}
                    <div className="overflow-y-auto max-h-[calc(100vh-200px)] custom-scrollbar pr-2 space-y-1">
                        {data.pathwayTree.map(node => (
                            <PathwayTreeItem
                                key={node.id}
                                node={node}
                                selectedPathways={selectedPathways}
                                onToggle={togglePathway}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* MAIN CONTENT */}
            <div className="flex-1 flex flex-col h-screen overflow-hidden relative">
                {/* Background Decoration */}
                <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2" />

                {/* Header */}
                <div className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-900/80 backdrop-blur-md z-10">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        {data.main} <span className="text-slate-500 font-normal">Network</span>
                    </h2>

                    <div className="flex items-center gap-4">
                        {/* Search */}
                        <div className="relative group">
                            <Icon name="Search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-cyan-400 transition-colors" />
                            <input
                                type="text"
                                placeholder="Search interactions..."
                                className="bg-slate-800 border border-slate-700 text-sm rounded-full pl-10 pr-4 py-2 w-64 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        {/* Filter Toggles */}
                        <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                            <button
                                onClick={() => setFilterType('all')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'all' ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                            >
                                All
                            </button>
                            <button
                                onClick={() => setFilterType('direct')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'direct' ? 'bg-cyan-900/50 text-cyan-300 shadow' : 'text-slate-400 hover:text-white'}`}
                            >
                                Direct
                            </button>
                            <button
                                onClick={() => setFilterType('shared')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filterType === 'shared' ? 'bg-purple-900/50 text-purple-300 shadow' : 'text-slate-400 hover:text-white'}`}
                            >
                                Shared
                            </button>
                        </div>
                    </div>
                </div>

                {/* Content Grid */}
                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar z-0">
                    <div className="mb-6 flex items-center justify-between">
                        <div className="text-sm text-slate-400">
                            Showing <span className="text-white font-bold">{filteredInteractions.length}</span> interactions
                        </div>
                    </div>

                    {filteredInteractions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-500 border-2 border-dashed border-slate-800 rounded-xl">
                            <Icon name="Search" size={48} className="mb-4 opacity-20" />
                            <p>No interactions found matching your filters.</p>
                            <button onClick={() => {setSearchQuery(''); setFilterType('all'); setSelectedPathways(new Set())}} className="mt-4 text-cyan-400 hover:underline">Clear Filters</button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pb-20">
                            {filteredInteractions.map((ix, idx) => (
                                <InteractionCard
                                    key={idx}
                                    interaction={ix}
                                    onShowEvidence={setModalInteraction}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Evidence Modal */}
            <Modal
                isOpen={!!modalInteraction}
                onClose={() => setModalInteraction(null)}
                title={modalInteraction ? `Evidence: ${modalInteraction.target}` : ''}
            >
                {modalInteraction && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                                <h4 className="text-xs text-slate-500 uppercase tracking-wider mb-2">Interaction Type</h4>
                                <div className="text-white font-medium capitalize flex items-center gap-2">
                                    <Icon name="Activity" size={16} className="text-cyan-400" />
                                    {modalInteraction.arrow || modalInteraction.interaction_effect || 'Unspecified'}
                                </div>
                            </div>
                            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                                <h4 className="text-xs text-slate-500 uppercase tracking-wider mb-2">Confidence Score</h4>
                                <div className="text-white font-medium">
                                    {Math.round((modalInteraction.confidence || 0) * 100)}%
                                </div>
                            </div>
                        </div>

                        <div>
                            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                                <Icon name="FileText" size={20} className="text-purple-400" />
                                Textual Evidence
                            </h3>
                            <div className="space-y-3">
                                {modalInteraction.evidence && modalInteraction.evidence.length > 0 ? (
                                    modalInteraction.evidence.map((ev, i) => (
                                        <div key={i} className="bg-slate-800/50 p-4 rounded-lg border-l-4 border-purple-500 text-slate-300 text-sm leading-relaxed">
                                            "{ev}"
                                        </div>
                                    ))
                                ) : (
                                    <div className="text-slate-500 italic">No textual evidence snippet available.</div>
                                )}
                            </div>
                        </div>

                        <div>
                            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                                <Icon name="Share2" size={20} className="text-blue-400" />
                                References (PMIDs)
                            </h3>
                            <div className="flex flex-wrap gap-2">
                                {modalInteraction.pmids && modalInteraction.pmids.length > 0 ? (
                                    modalInteraction.pmids.map((pmid, i) => (
                                        <a
                                            key={i}
                                            href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="px-3 py-1.5 bg-blue-900/30 text-blue-300 border border-blue-800/50 rounded hover:bg-blue-800/50 hover:text-white transition-colors text-xs font-mono flex items-center gap-1"
                                        >
                                            {pmid} <Icon name="Share2" size={10} />
                                        </a>
                                    ))
                                ) : (
                                    <div className="text-slate-500 italic">No PMIDs listed.</div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
};

// Render
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Dashboard />);
