import { useState } from "react";
import { MAX_FILE_BYTES, MAX_REGIONS } from "@achi/core/inputValidation";
import { MAX_SETS } from "../types";
import { LINK_DEFAULTS, buildLink } from "../lib/shareLink";
import { OfflinePanel } from "./OfflineStatus";
import { COPYRIGHT_YEAR, LAB_NAME, LAB_URL, LICENSE_URL, SOURCE_CODE_URL } from "../siteLinks";

const INTERVENE_CITATION =
  "Khan A, Mathelier A. Intervene: a tool for intersection and visualization of multiple gene or genomic region sets. BMC Bioinformatics. 2017;18:287. doi:10.1186/s12859-017-1708-7";

const INTERVENE_BIBTEX = `@article{khan2017intervene,
  author  = {Khan, Aziz and Mathelier, Anthony},
  title   = {Intervene: a tool for intersection and visualization of multiple gene or genomic region sets},
  journal = {BMC Bioinformatics},
  volume  = {18},
  number  = {1},
  pages   = {287},
  year    = {2017},
  doi     = {10.1186/s12859-017-1708-7}
}`;

const BEDTOOLS_CITATION =
  "Quinlan AR, Hall IM. BEDTools: a flexible suite of utilities for comparing genomic features. Bioinformatics. 2010;26(6):841–842. doi:10.1093/bioinformatics/btq033";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked (e.g. insecure context) — the text is on the page to select by hand.
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** This page's address, for the link examples; the example link opens this site's own example files. */
function linkExamples(): { appBase: string; exampleLink: string } {
  const appBase = `${window.location.origin}${import.meta.env.BASE_URL}`;
  const files = ["MCF7", "GM12878", "K562", "HepG2"].map((n) => ({ url: new URL(`examples/hg38_ses/${n}.bed`, appBase).href, name: n }));
  return { appBase, exampleLink: `#${buildLink({ mode: "regions", files, settings: LINK_DEFAULTS, view: "upset", sel: [] })}` };
}

export function HelpPage({ onBack }: { onBack: () => void }) {
  const { appBase, exampleLink } = linkExamples();
  const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
  return (
    <main className="helppage">
      <div className="helpinner">
        <button className="ghost" onClick={onBack}>
          ← Back to workspace
        </button>

        <h2>Documentation</h2>
        <p>
          Achi (pronounced “AH-chee”) is a browser-based framework for comparing, annotating and interpreting genomic intervals. It performs genomic interval intersections, annotation and enrichment analysis entirely in your browser. It supports 2–{MAX_SETS} input files in BED, 
          narrowPeak or VCF format and uses bedtools compiled to WebAssembly to compute intersections. Both the input sets and their intersection subsets can be annotated and 
          tested for enrichment. All processing happens locally within your browser tab, with no files uploaded to a server, helping keep sensitive genomic data under your control.
        </p>

        <h3 id="quick-start">Quick start</h3>
        <ol>
          <li>
            Drop two or more region files on <em>Drop BED files</em>, or press <em>Load example data</em>.
          </li>
          <li>
            Pick the genome assembly your files use. Achi checks chromosome names and lengths against it and warns
            you if a file looks like it belongs to a different assembly.
          </li>
          <li>
            Choose how much overlap counts as an overlap (<em>Minimum overlap</em>). The default is 1 bp.
          </li>
          <li>
            Read the result in the <em>UpSet</em>, <em>Venn</em>, <em>Pairwise</em> or <em>Table</em> tab. Click a bar,
            a Venn count or a table row to select that subset. To analyse a whole input set, click its set-size bar or
            name in the UpSet plot, or its name in the Venn diagram: it is added as, for example, <em>K562 (all)</em>,
            with the set's own regions, and can sit next to subsets. A whole set and its own subsets share regions, so
            tests that compare two groups directly are not run between them.
          </li>
          <li>
            Selected subsets and sets get their own summary, annotation and enrichment below the plot. Each also has a
            card in the right-hand <em>Selected subsets and sets</em> column with two tabs: <em>Regions</em> (shown
            first) and <em>Genes</em>, the nearest protein-coding gene of each region. The card's copy and download
            buttons act on the tab shown. Download everything at once with <em>Export selected</em>;{" "}
            <em>Export analysis</em> saves the whole analysis as one ZIP (see <a href="#export">below</a>). Hide the
            column with the arrow in its header to give the plots more width, and click the thin strip on the right to
            show it again.
          </li>
          <li>
            The <em>Set Summary</em> tab describes each input set: interval statistics, where regions fall relative to
            genes, and distance to the nearest TSS.
          </li>
        </ol>

        <h3 id="input">Input files</h3>
        <ul>
          <li>
            <strong>BED</strong> (3 or more tab-separated columns, 0-based start, end exclusive),{" "}
            <strong>narrowPeak/broadPeak</strong>, and <strong>VCF</strong>. VCF records are converted to BED the way
            bedtools reads them: from POS−1 to the end of REF, or to INFO <code>END</code> for symbolic alleles such as{" "}
            <code>&lt;DEL&gt;</code>.
          </li>
          <li>
            Gzip-compressed files (<code>.gz</code>) are decompressed in the browser.
          </li>
          <li>
            Limits: up to {MAX_SETS} sets, {mb} MB per file (uncompressed), {MAX_REGIONS.toLocaleString("en-US")} regions per
            file. For bigger inputs use the{" "}
            <a href="https://github.com/asntech/intervene" target="_blank" rel="noreferrer">
              Intervene command-line tool
            </a>
            , which uses the same algorithm.
          </li>
          <li>
            Header, <code>track</code>, <code>browser</code> and <code>#</code> comment lines are ignored. Malformed
            lines (too few columns, non-numeric or negative coordinates, end before start) are skipped, and the set card
            says how many and why. Space-separated lines are converted to tabs.
          </li>
          <li>
            Regions are used as given. Overlapping regions within one file are not merged, matching the command-line
            tool.
          </li>
        </ul>

        <h3 id="assembly">Assembly check</h3>
        <p>
          Each file's chromosome names and largest coordinates are compared with the selected assembly (hg38, hg19,
          mm10 or mm9). A coordinate past the end of a chromosome means the file is from a different assembly. For
          example, an hg38 file runs past the hg19 ends of chr5, chr17, chr18 and chr20. Ensembl-style names (
          <code>1</code>, <code>X</code>) are flagged too: <code>1</code> never matches <code>chr1</code>, so a set
          named that way shows no overlap with sets that use <code>chr</code> names. If all your sets share the same
          assembly and naming, overlaps between them are correct even when the selected assembly is wrong. What a wrong
          assembly breaks is everything that uses a genome file or reference annotation: Fisher, Reldist,
          Set Summary, region annotation and nearest genes.
        </p>

        <h3 id="problematic-regions">ENCODE problematic regions</h3>
        <p>
          For hg38, hg19 and mm10, each set card shows how many of its regions overlap the{" "}
          <a href="https://github.com/Boyle-Lab/Blacklist" target="_blank" rel="noreferrer">
            ENCODE problematic regions
          </a>{" "}
          (v2, Amemiya et al. 2019) by at least 1 bp. These are areas of the genome with anomalous signal in most
          sequencing experiments, whatever the cell type or assay. A high share points to a noisy or unfiltered file. Counting changes nothing about your data.
        </p>
        <p>
          <em>Exclude ENCODE problematic regions</em> (under BEDTools parameters) drops those regions from every set
          before anything is computed, like <code>bedtools intersect -v</code> against the list. It is off by
          default, so results match the command-line tool, which doesn't filter. Peak files from the ENCODE pipeline
          are usually filtered already. The filter always uses 1 bp overlap, whatever <em>Minimum overlap</em> is set
          to, and when it is on, the export ZIP's README says so.
        </p>
        <p>
          The list covers about 7 % of the genome on hg38 (227 Mb, including centromeres). Fisher's test still
          uses the whole genome as its background when the filter is on, so overlap between filtered sets can look
          slightly more enriched than it is. There is no v2 list for mm9.
        </p>

        <h3 id="method">How intersections are computed</h3>
        <p>
          Achi uses the same algorithm as the Intervene command-line tool. For each of the 2<sup>n</sup>−1 combinations of
          sets, it takes the regions of the first set in the combination and keeps those that overlap every other set
          in it (<code>bedtools intersect -u</code>) and no set outside it (<code>bedtools intersect -v</code>). So
          subset counts are regions of the combination's first set, in the order the sets are listed, and subset
          regions are whole input regions, not clipped fragments.
        </p>
        <p>
          To stay fast in the browser, each pair of sets is compared once with{" "}
          <code>bedtools intersect -c</code>, which counts how many regions of one set each region of the other
          overlaps, under the same overlap options. A region's subset follows from which sets it overlaps. This gives
          exactly the same result as the command-line tool's chain of <code>-u</code>/<code>-v</code> calls (checked
          region by region against native bedtools) with far fewer bedtools runs: 56 instead of 1,785 for eight sets. Results
          are cached, so adding a set only compares the new one, and switching a set on or off is instant.
        </p>
        <p>
          <em>Minimum overlap</em> passes <code>-f 0.50</code> (50 % of the region) or <code>-f 0.50 -r</code>{" "}
          (reciprocal) to every intersect call. <em>Advanced bedtools options</em> takes the CLI's{" "}
          <code>--bedtools-options</code> syntax, such as <code>f=0.75,s=true</code>. If WebAssembly is unavailable,
          a JavaScript fallback computes the 1 bp default only.
        </p>

        <h3 id="lists">Lists of names (gene lists, IDs)</h3>
        <p>
          Switch the rail to <em>Lists</em> to compare lists of names instead of genomic regions: gene symbols, SNP IDs
          or any identifiers, as in the Intervene command-line tool's list mode. Each file (.txt, .tsv, .csv) holds one
          name per line; the first column is used, lines starting with # are skipped, and a name repeated in a list
          counts once. Names are matched exactly, including case. Every name goes to the subset for exactly the lists
          that contain it, and the UpSet plot, Venn diagram, Table, selection and exports work as for regions; a subset
          downloads as a .txt list. The views that need genomic coordinates (Pairwise, Set Summary, Genome Browser,
          annotation and enrichment) are not offered for lists. <em>Load example gene lists</em> loads, for each
          example cell line, the protein-coding genes nearest to its peaks. Switching between regions and lists
          removes the loaded sets.
        </p>

        <h3 id="views">Views</h3>
        <ul>
          <li>
            <strong>UpSet</strong>: one bar per non-empty subset. Sort by size or degree, and hide small bars with{" "}
            <em>Min size</em>. With many sets the plot scrolls sideways.
          </li>
          <li>
            <strong>Venn</strong>: area-proportional for 2–3 sets (the triple overlap is approximate), schematic for 4
            sets, not available for 5 or more sets.
          </li>
          <li>
            <strong>Pairwise</strong>: base-pair Jaccard index; <code>bedtools fisher</code> (odds ratio and p-value
            against independent placement on the genome); or <code>bedtools reldist</code> with a Kolmogorov–Smirnov
            test against uniform relative distance.
          </li>
          <li>
            <strong>Table</strong>: every subset with exact region and base-pair counts.
          </li>
          <li>
            <strong>Set Summary</strong>: <code>bedtools summary</code> per set, plus each region classified against
            GENCODE protein-coding genes (promoter, UTR, exon, intron, downstream, distal) and its distance to the
            nearest TSS.
          </li>
          <li>
            <strong>Genome Browser</strong>: a genome-wide overview (GenomeSpy; see{" "}
            <a href="#genome-location">below</a>) above a genome browser (igv.js), linked: click a region in the
            overview, or Shift + drag within one chromosome, and the genome browser goes there; a red box in the
            overview marks where it is. One set of controls applies to both: <em>Show the input sets</em> and the
            bundled <em>Reference sets</em>. The genome browser shows one track per input set and per selected subset or set,
            GENCODE genes (one transcript per gene) and the ticked reference sets. Type a locus
            (<code>chr1:1,000,000-1,100,000</code>) or a gene name, or click <em>view</em> next to a region of a
            selected subset, or a gene on a card's <em>Genes</em> tab, to go there. Sets with more than 50,000 regions are drawn when
            zoomed in. <em>Public tracks</em> (optional, after you agree) adds SCREEN merged signal (DNase, ATAC,
            H3K4me3, H3K27ac, CTCF), the ENCODE cCRE registry, ENCODE signal and cell-type cCREs for the example cell
            lines, phyloP conservation (UCSC), JASPAR 2024 binding sites (shown below 20 kb, shaded by score), any
            ENCODE bigWig/bigBed found by search or accession, or a bigWig/bigBed URL. <em>Add local tracks</em> (or dropping files on
            the genome browser) shows files from your own disk: bigWig and bigBed of any size, and BED, narrowPeak,
            broadPeak, bedGraph or VCF (plain or .gz, up to 100 MB), BAM with its .bai, and CRAM with its .crai plus
            the reference FASTA it was made with (.fa with its .fai; it must match the assembly's chromosome
            lengths). With a reference loaded, reads show mismatches and the base sequence appears when zoomed in.
            They are read in the page only, never uploaded,
            and are for viewing: they are not part of the intersections. Interval files also appear as rows of the
            overview; chromosome names 1, 2, … are read as chr1, chr2, …. <em>SVG</em> and{" "}
            <em>PNG</em> export the current view, every track included, named after the locus.
          </li>
        </ul>
        <p>
          Plots export as SVG or PNG. The page address records the current view and the selected subsets and sets, so a bookmarked
          link reopens the same view once you load the same files again. It never contains your data.
        </p>

        <h3 id="genome-location">Genome-wide overview (Genome Browser tab)</h3>
        <p>
          At the top of the Genome Browser tab, a GenomeSpy view shows where each selected subset or set lies along the whole
          genome, with the input sets (<em>Show the input sets</em>) and any ticked bundled reference sets (ClinVar,
          GWAS Catalog, cCREs, enhancers, CpG islands, problematic regions) as context rows: a density strip per row
          (regions per Mb, by region midpoint; opacity relative to the row's densest Mb) above one row of regions per
          row. It follows the selection made in UpSet, Venn or Table. Ctrl/⌘ + scroll zooms from the whole genome to
          single regions, drag pans. Clicking a region shows it in the genome browser below; clicking a density bin
          zooms to that Mb in both. <em>Shift + drag</em> selects an interval and counts each row's regions in it;
          within one chromosome the genome browser follows. The red box in the chromosome strip is the genome
          browser's current locus. Exports as SVG or PNG. Rows of more than 500,000 regions are shown by density only.
          Fold the overview away with its header to give the genome browser the room. Public tracks are shown in the
          genome browser only.
        </p>

        <h3 id="enrichment">Enrichment of selected subsets and sets</h3>
        <p>
          <em>Run enrichment</em> (below the selected subsets and sets) tests each selected subset or set against every built-in
          reference set for the assembly: ENCODE cCREs, FANTOM5 and VISTA enhancers, CpG islands, ClinVar and GWAS
          Catalog variants. A region counts as a hit if it overlaps the reference set by at least 1 bp.
        </p>
        <p>
          The background is <strong>every other region of your analysis</strong>: all regions assigned to some subset,
          each input locus once. So the question is what sets this subset apart within your experiment, not compared
          with the whole genome. The test is Fisher's exact test on the 2×2 table of regions (in the subset or not ×
          hit or not). With <em>Adjust for region length</em> (on by default) it is the Cochran–Mantel–Haenszel test
          across five region-length strata, because longer regions hit reference sets more often by chance. p-values
          are adjusted with Benjamini–Hochberg across all cells of a run (q). The heatmap colours the odds ratio:{" "}
          red for enriched, blue for depleted; stars mark q &lt; 0.05, 0.01 and 0.001, and hovering a cell gives its
          numbers. It shows the 10 most significant reference sets (<em>Show top</em> changes how many); the table and the
          TSV keep them all.
        </p>
        <p>
          A reference set that is one of your analysed input sets is not tested. There is no whole-genome background:{" "}
          <code>bedtools fisher</code> breaks down when region sizes differ greatly (e.g. 30 kb peaks against 1-bp
          variants), which is also why some Pairwise → Fisher cells show "n/a".
        </p>

        <h3 id="go-enrichment">GO enrichment of selected subsets and sets</h3>
        <p>
          <em>Run GO enrichment</em> tests Gene Ontology terms for each selected subset or set, separately for biological
          process, molecular function and cellular component, with one of two methods. Results come as one tab per
          subset, each with its own chart, table and downloads; every GO id links to its page in AmiGO (opens in a new
          tab; only the GO id is sent). Both methods follow a published approach and are reimplemented here to run in
          your browser — they are not copies of those tools, so results can differ slightly from theirs. Each method's
          settings start at its published defaults, can be changed under{" "}
          <em>Settings</em>, and are reset with one click.
        </p>
        <p>
          <strong>GREAT-like</strong> links each region to genes with GREAT's basal-plus-extension rule (McLean et al.{" "}
          <em>Nat Biotechnol</em> 2010): every protein-coding gene gets a basal domain from 5 kb upstream to 1 kb
          downstream of its TSS, extended in both directions to the nearest other gene's basal domain, up to 1 Mb. A
          region counts at its middle base. Terms with 5–1,000 genes are tested by default. The background is a
          setting:
        </p>
        <ul>
          <li>
            <strong>Genome</strong> (default): GREAT's binomial test over regions (against the fraction of the
            genome, excluding assembly gaps, in the term's regulatory domains) and hypergeometric test over genes. A
            term is marked significant when both q-values are below 0.05 and the binomial fold is at least 2, as in
            GREAT.
          </li>
          <li>
            <strong>Input sets</strong>: Fisher's exact test of the subset's regions against all other regions of your
            analysis — which functions set the subset apart within your experiment.
          </li>
        </ul>
        <p>
          <strong>Cistrome-GO-like</strong> follows the approach of Cistrome-GO (Li et al. <em>Nucleic Acids Res</em>{" "}
          2019): it scores every gene's{" "}
          <em>regulatory potential</em>: the sum, over the subset's regions within 15 half-decay distances of any of
          its transcript starts, of 2<sup>−distance/half-decay</sup>. The half-decay distance is 1 kb when at least 20%
          of the top regions lie within 1 kb of a TSS, otherwise 10 kb (or your choice). Scores are scaled and the
          gene's typical score across thousands of Cistrome DB ChIP-seq data sets is subtracted, so genes that are near
          many peaks in every experiment do not dominate. Genes are ranked by this adjusted score and each term is tested
          with the XL-mHG test (Eden et al. 2007; Wagner 2015) for its genes being concentrated at the top of the
          ranking. With a score column (narrowPeak column 5) the top 10,000 regions by score are used, otherwise all.
          Terms are those of the current GO release with 11–1,999 genes, after removing near-duplicate terms (Jaccard
          &gt; 0.85), as Cistrome-GO does; terms with q &lt; 0.2 are marked, as on go.cistrome.org. The table lists
          each term's leading genes — its genes above the optimal cutoff. It reuses the Cistrome-GO gene model and background scores and was checked against the package's own code;
          three small differences are deliberate (a bookkeeping slip at the end of the last chromosome, gene rank
          positions off by one in the package, and a newer GO release) and are described in the methods.
        </p>
        <p>
          q-values are Benjamini–Hochberg over all tested terms of a namespace, per subset. The chart shows the top 15
          enriched terms of the subset; the TSV downloads have every term. GO data: Gene Ontology Consortium (CC BY 4.0;
          ontology release 2026-07-26, annotations 2026-05-21).
        </p>

        <h3 id="motifs">Motif enrichment (JASPAR)</h3>
        <p>
          <em>Motif enrichment</em> asks which transcription factor motifs are more common in each selected subset or set than in
          the other regions of the analysis. It scans JASPAR 2026 vertebrate matrices (bundled; by default the 1,019 of CORE, non-redundant, or under{" "}
          <em>Settings</em> every CORE version, the UNVALIDATED collection, or CORE and UNVALIDATED together) on both strands
          of a window around each region's centre (±100 bp by default), counts the regions with at least one site (p &lt; 1e-4),
          and compares a group with the rest within strata of GC and CpG content (Cochran–Mantel–Haenszel test, Benjamini–Hochberg
          adjusted). The heatmap shows the 10 most enriched motifs with their logos (one per TF family by default; <em>Show top</em>{" "}
          changes how many), coloured by odds ratio with stars for q, and hovering a cell gives its numbers; the table links
          each matrix to JASPAR. Long regions such as super-enhancers are represented by their centre only.
        </p>
        <p>
          The genome sequence comes from <em>This computer</em> (a .2bit, or a FASTA with its .fai: nothing is downloaded), a{" "}
          <em>Private download</em> of whole chromosomes from UCSC (about 775 MB for hg38, the same whatever your regions, kept in
          the browser for later runs), or <em>Exact</em> range requests for your regions only (a fraction of a MB, but the server
          sees roughly where they are; asked every run, up to 2,000 regions).
        </p>

        <h3 id="signal">Signal profiles and heatmaps</h3>
        <p>
          <em>Signal at the selected subsets and sets</em> shows a bigWig's signal (ChIP-seq, ATAC, DNase, conservation …) across
          and around the regions of each selected subset or set, as deepTools <code>computeMatrix</code>,{" "}
          <code>plotProfile</code> and <code>plotHeatmap</code> do; the numbers match deepTools 4.0.0. Add bigWigs from
          your computer (any size: only the parts needed are read, here in the page; nothing is uploaded). bigWigs added
          in the Genome Browser tab are offered too, and <em>Load example signal</em> adds ENCODE H3K27ac for the example
          cell lines (cut to the example regions, 200 bp bins).
        </p>
        <p>
          <em>Scale regions</em> stretches every region to the same length with flanks, for broad regions such as
          super-enhancers or genes; <em>Reference point</em> takes a window around each region's centre, start or end,
          for peaks. The card picks one from the median region length. Each bin is the mean signal over its bases with
          data. The profile shows the mean ± standard error per subset; the heatmap shows every region, sorted by mean
          signal (hover for values; click a row to show it in the genome browser). Optional k-means groups the rows into
          clusters instead (download them as BED). Below, a box plot of each region's mean signal per subset, and a
          two-sided Mann–Whitney U test between subsets (Benjamini–Hochberg across pairs when more than two are
          selected), drawn as brackets over the boxes: by default the significant pairs (p or q ≤ 0.05) with their value; all pairs or significance stars can be chosen under the plot, as can a linear or symmetric-log y axis. Each region is a point, coloured by subset. Above
          20,000 regions a fixed random sample of 20,000 is used.
        </p>
        <p>
          <em>Public tracks…</em> adds the genome browser's ENCODE, SCREEN and UCSC bigWigs, or a pasted https URL, after
          you agree to the hosts named. By default they are read <em>privately</em>: the card downloads a whole-genome
          summary of each file (about 14 MB at ~3 kb for an ENCODE signal file), the same download whatever your regions,
          so the server learns nothing about them; profiles are then at that resolution. <em>Exact</em> reads each region
          at full resolution by range requests, which shows the server roughly where your regions are: the card asks
          every time, with the size and time it expects, and reads at most 2,000 regions.
        </p>

        <h3 id="export">Export and restore an analysis</h3>
        <p>
          <em>Export analysis</em> saves one ZIP, made in the page: <code>methods.md</code>, a methods paragraph for
          the analysis with its references (the build of Achi, the inputs, assembly, overlap rule, filters,
          the selected subsets and sets and, if you ran them, the enrichment, GO and gene-list settings);{" "}
          <code>settings.json</code>; every subset as BED (or .txt for lists); tables of the inputs and all subsets; the
          enrichment and GO results and gene lists you computed; and the plots on screen at that moment as SVG.{" "}
          <code>settings.json</code> holds no data: the parameters, and each input's name, file name, size and SHA-256
          checksum. <em>Restore settings…</em> reads it back: the parameters apply at once, and the selected subsets and sets
          return once you load the same files (matched by set name; files whose checksum differs are named).
        </p>

        <h3 id="links">Open public files from a link</h3>
        <p>
          A link can open Achi with public files already named, for a data portal, a lab page or a
          paper's supplement. Everything after <code>#</code> stays in the browser and is never sent to this site.
          Each <code>bed=</code> is one set (BED, narrowPeak, broadPeak, bedGraph or VCF, plain or .gz); a{" "}
          <code>name=</code> after it names that set. For lists of names, use <code>list=</code> instead. Up to{" "}
          {MAX_SETS} sets, https addresses only, and the server must allow downloads from other web pages (ENCODE's{" "}
          <code>@@download</code> links do; many lab servers and Galaxy instances do too). The address must be
          URL-encoded.
        </p>
        <pre className="help-code">{`${appBase}#bed=<url>&name=K562&bed=<url>&name=HepG2&assembly=hg38&overlap=reciprocal50&view=upset`}</pre>
        <p>
          Optional settings: <code>assembly</code> (hg38, hg19, mm10, mm9), <code>overlap</code> (1bp, fraction50,
          reciprocal50), <code>bedtools</code> (the Advanced field, e.g. <code>f=0.25,r</code>),{" "}
          <code>blacklist=1</code>, <code>sort=degree</code>, <code>min</code> (smallest UpSet bar),{" "}
          <code>stat</code> (jaccard, fisher, reldist), <code>view</code> and <code>sel</code> (selected subsets by their number; a negative number selects a
          whole set: <code>-1</code> the first, <code>-2</code> the second, <code>-4</code> the third, <code>-8</code> the
          fourth…).
          Opening a link always asks first: it lists every file and the server it comes from, and nothing is
          downloaded until you agree. <a href={exampleLink}>Try it with the example data</a>.
        </p>
        <p>
          When every set came from a link, <em>Copy link</em> copies one that reopens the same files with the same
          settings, view and selection; the address bar holds the same link. A file from your computer is never put
          in a link, so <em>Copy link</em> is off once one is loaded. A button for your page:
        </p>
        <pre className="help-code">{`<a href="${appBase}#bed=<url-encoded file URL>&name=My%20peaks">Open in Achi</a>`}</pre>

        <h3 id="keyboard">Keyboard</h3>
        <p>
          Tab moves to each UpSet bar, Venn count and table row. Enter or Space selects or deselects it. Every
          colour-coded value is also listed in the Table view and in each mark's tooltip.
        </p>

        <h3 id="privacy">Privacy</h3>
        <p>
          Files are read by your browser and processed by bedtools running inside it. Nothing you load is sent anywhere.
          The only network requests are for this site's own static files: the application, the bedtools WebAssembly
          binary, example data and reference annotation. There is no login, no account and no server-side storage. Links
          out (GO terms to AmiGO) open only when you click them and send only the term id. The genome browser shows
          only your files and data bundled with Achi: its genome is the bundled chromosome sizes, gene search runs
          here, and igv.js's own genome list and search service are switched off. The one exception is{" "}
          <em>Public tracks</em> in the genome browser, off until you agree: the servers named in that notice
          (www.encodeproject.org, encode-public.s3.amazonaws.com, downloads.wenglab.org, hgdownload.soe.ucsc.edu, or
          the host of a URL you paste)
          then see which regions you view, and ENCODE sees the words you search for. Your files are never sent. The
          agreement lasts until you reload the page or press <em>Stop public tracks</em>. A{" "}
          <a href="#links">link naming public files</a> is the other: after you agree, your browser downloads those
          files from their servers, which see the download and nothing else.
        </p>

        <h3 id="offline">Offline use</h3>
        <OfflinePanel />

        <h3 id="reference-data">Reference data</h3>
        <p>
          Built-in annotation sets are added from <em>External annotations</em> like any uploaded file, and only the
          ones for the selected assembly are listed.
        </p>
        <ul>
          <li>Chromosome sizes, chromosome bands and CpG islands: UCSC Genome Browser.</li>
          <li>
            Gene Ontology (ontology release 2026-07-26, human and mouse annotations 2026-05-21): The Gene Ontology
            Consortium. <em>Genetics</em> 2023;224:iyad031. GREAT regulatory domains: McLean CY, et al.{" "}
            <em>Nat Biotechnol</em> 2010;28:495–501.
          </li>
          <li>
            Cistrome-GO gene model and background regulatory potential (package commit 6b7f003, MIT): Li S, Wan C,
            Zheng R, Fan J, Dong X, Meyer CA, Liu XS. Cistrome-GO: a web server for functional enrichment analysis of
            transcription factor ChIP-seq peaks. <em>Nucleic Acids Res</em> 2019;47:W206–W211. XL-mHG test: Eden E,
            Lipson D, Yogev S, Yakhini Z. <em>PLoS Comput Biol</em> 2007;3:e39; Wagner F. The XL-mHG test for
            enrichment: a technical report. arXiv:1507.07905 (2015).
          </li>
          <li>
            ENCODE problematic regions v2 (hg38, hg19, mm10): Amemiya HM, Kundaje A, Boyle AP. The ENCODE Blacklist:
            identification of problematic regions of the genome. <em>Sci Rep</em> 2019;9:9354.
          </li>
          <li>Gene annotation: GENCODE v50 (hg38), v19 (hg19), vM25 (mm10), vM1 (mm9), protein-coding genes only.</li>
          <li>
            Genome browser genes: the same GENCODE releases, all genes, one transcript per gene: the Ensembl canonical
            transcript where GENCODE marks it (hg38; for hg19 through the hg38 transcript IDs), otherwise the basic
            transcript with the best APPRIS and support level, then the longest coding sequence.
          </li>
          <li>
            ENCODE candidate cis-regulatory elements, V4 registry, all cell types (hg38, mm10): promoter-like, proximal
            enhancer-like and CTCF-bound classes. Registry: Moore JE, et al. <em>Nature</em> 2020;583:699–710. Distal
            enhancer-like elements (1.5 million on hg38) are too many to process in the browser and are not included.
          </li>
          <li>
            FANTOM5 transcribed enhancers (hg38, hg19, mm10, mm9): Andersson R, et al. <em>Nature</em>{" "}
            2014;507:455–461.
          </li>
          <li>
            VISTA enhancers (hg38, mm10), positive elements only: Visel A, et al. <em>Nucleic Acids Res.</em>{" "}
            2007;35:D88–D92.
          </li>
          <li>
            ClinVar germline pathogenic and likely pathogenic variants with review criteria provided (hg38, hg19):
            Landrum MJ, et al. <em>Nucleic Acids Res.</em> 2018;46:D1062–D1067.
          </li>
          <li>
            NHGRI-EBI GWAS Catalog, variants with a genome-wide significant association, P ≤ 5×10⁻⁸ (hg38): Sollis E,
            et al. <em>Nucleic Acids Res.</em> 2023;51:D977–D985.
          </li>
        </ul>
        <p>
          Large sets (ClinVar, GWAS Catalog, proximal enhancer-like cCREs, 250k–340k regions each) take about 10–15
          seconds to add on a typical laptop.
        </p>

        <h3 id="cite">How to cite</h3>
        <p>Achi builds on Intervene. If Achi helps your work, please cite:</p>
        <blockquote className="citation">{INTERVENE_CITATION}</blockquote>
        <div className="citeactions">
          <CopyButton text={INTERVENE_CITATION} label="Copy citation" />
          <CopyButton text={INTERVENE_BIBTEX} label="Copy BibTeX" />
        </div>
        <p>Intersections are computed with BEDTools:</p>
        <blockquote className="citation">{BEDTOOLS_CITATION}</blockquote>
        <p>
          bedtools runs in the browser through{" "}
          <a href="https://github.com/biowasm/biowasm" target="_blank" rel="noreferrer">
            biowasm
          </a>
          .
        </p>

        <h3 id="source">Source code and licence</h3>
        <p>
          The source code is on{" "}
          <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          under the{" "}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
            MIT licence
          </a>
          . Bundled reference data keeps its providers' terms, listed with each source above. The genome browser is
          igv.js 3.8.10 (Robinson JT, Thorvaldsdóttir H, Turner D, Mesirov JP. igv.js: an embeddable JavaScript
          implementation of the Integrative Genomics Viewer (IGV). <em>Bioinformatics</em> 2023;39:btac830), MIT
          licence, Copyright (c) 2014-2025 Broad Institute of MIT and Harvard, Regents of the University of California. The genome-wide overview is GenomeSpy 1.3.0 (Lavikka K, et al. Deciphering cancer genomes with GenomeSpy: a
          grammar-based visualization toolkit. <em>GigaScience</em> 2024;13:giae040), MIT licence.
          Achi is developed by
          the{" "}
          <a href={LAB_URL} target="_blank" rel="noreferrer">
            {LAB_NAME}
          </a>{" "}
          (© {COPYRIGHT_YEAR}).
        </p>

        <p className="free" style={{ marginTop: 28 }}>
          Achi is free and open to all users and there is no login requirement.
        </p>
      </div>
    </main>
  );
}
