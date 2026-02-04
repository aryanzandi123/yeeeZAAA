// Ensure React/ReactDOM are available
const { useState, useEffect, useRef, useMemo } = React;
const { createRoot } = ReactDOM;
const { Search, Filter, Share2, FileText, Activity, Layers, Network, Grid, X, ChevronRight, ChevronDown, Info } = lucide;

// --- Helper: Build Hierarchy if Missing ---
const buildHierarchy = (interactions) => {
    // Group interactions by their primary pathway or type
    const groups = {};
    interactions.forEach(ix => {
        // Use 'mechanism' or 'interaction_type' as a proxy for pathway if no explicit pathway field
        const key = ix.pathway || ix.interaction_type || 'Other';
        if (!groups[key]) groups[key] = [];
        groups[key].push(ix);
    });

    return Object.entries(groups).map(([name, items], idx) => ({
        id: `pathway-${idx}`,
        name: name,
        children: [], // Flat structure for now, can be expanded if recursive data is available
        interactions: items
    }));
};

// --- Helper: Process Data ---
const processData = (rawData) => {
    console.log("Processing Data:", rawData);
    let vizData = {};

    // Handle different backend formats
    if (rawData.snapshot_json) {
        vizData = rawData.snapshot_json;
    } else if (rawData.main) {
        vizData = rawData;
    } else {
        console.error("Unknown data format");
        return null;
    }

    const interactions = vizData.interactions || vizData.interactors || [];
    const main = vizData.main || vizData.primary || 'Protein';

    // Ensure hierarchy exists
    let pathwayTree = vizData.pathwayTree;
    if (!pathwayTree || pathwayTree.length === 0) {
        console.warn("Pathway tree missing, building from interactions...");
        pathwayTree = buildHierarchy(interactions);
    }

    return {
        main,
        interactions,
        pathwayTree
    };
};

// --- Component: Modal ---
const Modal = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-slate-700">
                    <h3 className="text-lg font-bold text-white">{title}</h3>
                    <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded-full transition-colors">
                        <X size={20} className="text-slate-400" />
                    </button>
                </div>
                <div className="p-6 overflow-y-auto custom-scrollbar">
                    {children}
                </div>
            </div>
        </div>
    );
};

// --- Component: Icon Wrapper ---
const Icon = ({ name, size = 16, className }) => {
    const LucideIcon = lucide[name];
    if (!LucideIcon) return null;
    return <LucideIcon size={size} className={className} />;
};

// --- Component: Pathway Tree Item (Recursive) ---
const PathwayTreeItem = ({ node, level = 0, selectedPathways, onToggle }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedPathways.has(node.id);

    return (
        <div className="select-none">
            <div
                className={`flex items-center py-1.5 px-2 rounded-md cursor-pointer transition-colors hover:bg-slate-800/50 ${isSelected ? 'bg-cyan-900/20 text-cyan-300' : 'text-slate-400'}`}
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                onClick={() => onToggle(node.id)}
            >
                <div
                    className="mr-2 p-0.5 rounded hover:bg-slate-700/50"
                    onClick={(e) => {
                        e.stopPropagation();
                        setIsExpanded(!isExpanded);
                    }}
                >
                    {hasChildren && (
                        isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                    )}
                    {!hasChildren && <div className="w-[14px]" />}
                </div>

                <span className="text-xs truncate flex-1">{node.name}</span>
                {node.interactions && node.interactions.length > 0 && (
                    <span className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded-full ml-2 opacity-60">
                        {node.interactions.length}
                    </span>
                )}
            </div>

            {hasChildren && isExpanded && (
                <div>
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

// --- Component: Interaction Card ---
const InteractionCard = ({ interaction, onShowEvidence }) => {
    const target = interaction.primary || interaction.target; // Handle both formats
    const type = interaction.interaction_type || 'Unknown';
    const arrow = interaction.arrow || interaction.interaction_effect || 'interacts';
    const confidence = interaction.confidence ? Math.round(interaction.confidence * 100) : 0;

    return (
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 hover:border-cyan-500/30 hover:shadow-lg hover:shadow-cyan-500/5 transition-all group">
            <div className="flex justify-between items-start mb-3">
                <h4 className="font-bold text-lg text-white group-hover:text-cyan-400 transition-colors">{target}</h4>
                <div className="flex items-center gap-1 bg-slate-800 px-2 py-1 rounded text-[10px] font-mono text-slate-400 uppercase">
                    {type}
                </div>
            </div>

            <div className="text-sm text-slate-400 mb-4 line-clamp-2 min-h-[40px]">
                {interaction.support_summary || interaction.summary || "No summary available."}
            </div>

            <div className="flex items-center justify-between mt-auto pt-3 border-t border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className={`w-2 h-2 rounded-full ${confidence > 80 ? 'bg-green-500' : confidence > 50 ? 'bg-yellow-500' : 'bg-red-500'}`}></span>
                    {confidence}% Conf.
                </div>
                <button
                    onClick={() => onShowEvidence(interaction)}
                    className="flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 transition-colors bg-cyan-950/30 px-3 py-1.5 rounded-full border border-cyan-900/50 hover:border-cyan-500/50"
                >
                    <FileText size={12} />
                    Evidence
                </button>
            </div>
        </div>
    );
};

// --- Component: Force Graph View ---
const GraphView = ({ data, width, height, onNodeClick }) => {
    const graphRef = useRef();

    // Transform data for react-force-graph
    const graphData = useMemo(() => {
        const nodes = [{ id: data.main, group: 'main', val: 20 }];
        const links = [];

        // Use a set to avoid duplicates
        const addedNodes = new Set([data.main]);

        data.interactions.forEach(ix => {
            const target = ix.primary || ix.target;
            if (!addedNodes.has(target)) {
                nodes.push({
                    id: target,
                    group: ix.interaction_type,
                    val: 10,
                    // Store full interaction data for click handling
                    ...ix
                });
                addedNodes.add(target);
            }

            links.push({
                source: data.main,
                target: target,
                value: ix.confidence || 1
            });
        });

        return { nodes, links };
    }, [data]);

    return (
        <div className="w-full h-full bg-slate-950">
             {/* Using the global ForceGraph2D from CDN */}
            <ForceGraph2D
                ref={graphRef}
                width={width}
                height={height}
                graphData={graphData}
                nodeLabel="id"
                nodeColor={node => node.group === 'main' ? '#06b6d4' : (node.group === 'direct' ? '#10b981' : '#8b5cf6')}
                nodeRelSize={6}
                linkColor={() => '#334155'}
                linkWidth={link => link.value * 2}
                linkDirectionalParticles={2}
                linkDirectionalParticleSpeed={d => d.value * 0.001}
                backgroundColor="#020617"
                onNodeClick={node => {
                    // Focus camera on node
                    if (graphRef.current) {
                        graphRef.current.centerAt(node.x, node.y, 1000);
                        graphRef.current.zoom(8, 2000);
                    }
                    if (node.id !== data.main) {
                        onNodeClick(node); // Pass interaction data up
                    }
                }}
            />
        </div>
    );
};


// --- Main Application ---
const Dashboard = () => {
    const [data, setData] = useState(null);
    const [selectedPathways, setSelectedPathways] = useState(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [filterType, setFilterType] = useState('all'); // 'all', 'direct', 'shared'
    const [modalInteraction, setModalInteraction] = useState(null);
    const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'graph'

    // For graph sizing
    const contentRef = useRef(null);
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

    useEffect(() => {
        // Load data from global window.SNAP
        if (window.SNAP) {
            console.log("Loading SNAP data:", window.SNAP);
            const processed = processData(window.SNAP);
            setData(processed);
        } else {
            console.error("No SNAP data found on window");
        }

        // Window resize handler
        const handleResize = () => {
            if (contentRef.current) {
                setDimensions({
                    width: contentRef.current.offsetWidth,
                    height: contentRef.current.offsetHeight
                });
            }
        };

        window.addEventListener('resize', handleResize);
        // Initial size
        setTimeout(handleResize, 100);

        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Effect to update graph size when toggling views
    useEffect(() => {
        if (viewMode === 'graph' && contentRef.current) {
             setDimensions({
                width: contentRef.current.offsetWidth,
                height: contentRef.current.offsetHeight
            });
        }
    }, [viewMode]);


    if (!data) return <div className="text-white p-10">Loading visualization data...</div>;

    // Filter Logic
    const filteredInteractions = data.interactions.filter(ix => {
        const target = ix.primary || ix.target;
        // Search
        if (searchQuery && !target.toLowerCase().includes(searchQuery.toLowerCase())) return false;

        // Type Filter
        if (filterType === 'direct' && ix.interaction_type !== 'direct') return false;

        // Pathway Filter (if implemented in data)
        // This relies on the interaction having a pathway ID or the parent node logic
        // For now, simpler: if selectedPathways is not empty, check if this interaction belongs to selected
        // This requires interactions to map back to hierarchy nodes.
        // Simplified: If any pathway is selected, show nothing unless we map them.
        // Ideally, we'd traverse the tree to find selected nodes' interactions.

        return true;
    });

    const togglePathway = (id) => {
        const newSet = new Set(selectedPathways);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedPathways(newSet);
    };

    return (
        <div className="flex h-screen bg-slate-950 text-slate-200 font-sans">
            {/* SIDEBAR */}
            <div className="w-80 border-r border-slate-800 bg-slate-900/50 backdrop-blur-xl flex flex-col z-20 shadow-xl">
                <div className="p-6 border-b border-slate-800">
                    <div className="flex items-center gap-3 mb-1">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
                            <Activity size={18} className="text-white" />
                        </div>
                        <h1 className="font-bold text-lg tracking-tight text-white">ProPath <span className="text-cyan-400 text-xs font-mono ml-1">v2.0</span></h1>
                    </div>
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
                        {/* View Switcher */}
                        <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                            <button
                                onClick={() => setViewMode('grid')}
                                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
                                title="Grid View"
                            >
                                <Grid size={16} />
                            </button>
                            <button
                                onClick={() => setViewMode('graph')}
                                className={`p-1.5 rounded-md transition-all ${viewMode === 'graph' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
                                title="Graph View"
                            >
                                <Network size={16} />
                            </button>
                        </div>

                        {/* Search */}
                        <div className="relative group">
                            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-cyan-400 transition-colors" />
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
                        </div>
                    </div>
                </div>

                {/* Content Grid / Graph */}
                <div ref={contentRef} className="flex-1 overflow-y-auto custom-scrollbar z-0 relative">
                    {viewMode === 'grid' ? (
                        <div className="p-6">
                            <div className="mb-6 flex items-center justify-between">
                                <div className="text-sm text-slate-400">
                                    Showing <span className="text-white font-bold">{filteredInteractions.length}</span> interactions
                                </div>
                            </div>

                            {filteredInteractions.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-64 text-slate-500 border-2 border-dashed border-slate-800 rounded-xl">
                                    <Search size={48} className="mb-4 opacity-20" />
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
                    ) : (
                        // Graph View
                        <GraphView
                            data={data}
                            width={dimensions.width}
                            height={dimensions.height}
                            onNodeClick={setModalInteraction}
                        />
                    )}
                </div>
            </div>

            {/* Evidence Modal */}
            <Modal
                isOpen={!!modalInteraction}
                onClose={() => setModalInteraction(null)}
                title={modalInteraction ? `Evidence: ${modalInteraction.primary || modalInteraction.target}` : ''}
            >
                {modalInteraction && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                                <h4 className="text-xs text-slate-500 uppercase tracking-wider mb-2">Interaction Type</h4>
                                <div className="text-white font-medium capitalize flex items-center gap-2">
                                    <Activity size={16} className="text-cyan-400" />
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

                        {/* Textual Evidence Fix: Check if evidence is object or string */}
                        <div>
                            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                                <FileText size={20} className="text-purple-400" />
                                Textual Evidence
                            </h3>
                            <div className="space-y-3">
                                {modalInteraction.evidence && modalInteraction.evidence.length > 0 ? (
                                    modalInteraction.evidence.map((ev, i) => {
                                        // CRITICAL FIX: Handle both string and object evidence
                                        const text = typeof ev === 'string' ? ev : ev.relevant_quote;
                                        const meta = typeof ev === 'object' ? ev : null;

                                        return (
                                            <div key={i} className="bg-slate-800/50 p-4 rounded-lg border-l-4 border-purple-500 text-slate-300 text-sm leading-relaxed">
                                                "{text}"
                                                {meta && (
                                                    <div className="mt-2 text-xs text-slate-500 flex items-center gap-2">
                                                        <span className="font-bold">{meta.year}</span>
                                                        <span className="italic">{meta.journal}</span>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="text-slate-500 italic">No textual evidence snippet available.</div>
                                )}
                            </div>
                        </div>

                        <div>
                            <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                                <Share2 size={20} className="text-blue-400" />
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
                                            {pmid} <Share2 size={10} />
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
