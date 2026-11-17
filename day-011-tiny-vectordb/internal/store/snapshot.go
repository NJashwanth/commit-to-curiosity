package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"

	"github.com/NJashwanth/commit-to-curiosity/day-011-tiny-vectordb/internal/hnsw"
)

// Snapshot file layout (all integers little endian):
//
//	offset 0   4 bytes  magic "TVDB"
//	offset 4   uint16   format version
//	offset 6   uint16   reserved, 0
//	offset 8   uint64   payload length n
//	offset 16  n bytes  payload
//	offset 16+n uint32  CRC-32C of bytes [0, 16+n)
//
// The payload is the collection config, the encoded HNSW graph, and the
// documents (node id, string id, metadata JSON) as length-prefixed fields.
const (
	snapshotMagic   = "TVDB"
	SnapshotVersion = 1
	headerSize      = 16
	trailerSize     = 4
	// FileExt is the extension of collection snapshot files.
	FileExt = ".tvdb"
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// Snapshot errors. Each is wrapped with details, so check with errors.Is.
var (
	ErrBadMagic           = errors.New("not a tiny-vectordb snapshot (bad magic bytes)")
	ErrUnsupportedVersion = errors.New("unsupported snapshot version")
	ErrTruncated          = errors.New("snapshot is truncated")
	ErrChecksum           = errors.New("snapshot checksum mismatch: the file is corrupt")
	ErrCorrupt            = errors.New("snapshot is corrupt")
)

func appendString(b []byte, s string) []byte {
	b = binary.AppendUvarint(b, uint64(len(s)))
	return append(b, s...)
}

// MarshalSnapshot encodes the collection into a complete snapshot file
// image. It also returns the write version it captured, for MarkSaved.
func (c *Collection) MarshalSnapshot() ([]byte, uint64, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	graph, err := c.index.MarshalBinary()
	if err != nil {
		return nil, 0, err
	}
	p := make([]byte, 0, len(graph)+len(c.byID)*48+128)
	p = appendString(p, c.cfg.Name)
	p = appendString(p, c.cfg.Metric)
	for _, v := range []int{c.cfg.Dim, c.cfg.M, c.cfg.EfConstruction, c.cfg.EfSearch} {
		p = binary.AppendUvarint(p, uint64(v))
	}
	p = binary.AppendUvarint(p, uint64(len(graph)))
	p = append(p, graph...)

	p = binary.AppendUvarint(p, uint64(len(c.byID)))
	for node, id := range c.keys {
		if id == "" {
			continue
		}
		p = binary.AppendUvarint(p, uint64(node))
		p = appendString(p, id)
		var meta []byte
		if c.meta[node] != nil {
			if meta, err = json.Marshal(c.meta[node]); err != nil {
				return nil, 0, err
			}
		}
		p = binary.AppendUvarint(p, uint64(len(meta)))
		p = append(p, meta...)
	}

	out := make([]byte, headerSize, headerSize+len(p)+trailerSize)
	copy(out, snapshotMagic)
	binary.LittleEndian.PutUint16(out[4:], SnapshotVersion)
	binary.LittleEndian.PutUint64(out[8:], uint64(len(p)))
	out = append(out, p...)
	out = binary.LittleEndian.AppendUint32(out, crc32.Checksum(out, castagnoli))
	return out, c.version, nil
}

// UnmarshalSnapshot decodes a snapshot file image. The checks run in an
// order that gives the most useful error: magic, then version (so a file
// from a newer build says so instead of "corrupt"), then length, then
// checksum, then structure.
func UnmarshalSnapshot(data []byte) (*Collection, error) {
	if len(data) < 4 || string(data[:4]) != snapshotMagic {
		return nil, ErrBadMagic
	}
	if len(data) < headerSize {
		return nil, fmt.Errorf("%w: %d bytes, the header alone is %d", ErrTruncated, len(data), headerSize)
	}
	if v := binary.LittleEndian.Uint16(data[4:]); v != SnapshotVersion {
		return nil, fmt.Errorf("%w: file is version %d, this build reads version %d", ErrUnsupportedVersion, v, SnapshotVersion)
	}
	n := binary.LittleEndian.Uint64(data[8:])
	avail := uint64(max(0, len(data)-headerSize-trailerSize))
	if len(data) < headerSize+trailerSize || n > avail {
		return nil, fmt.Errorf("%w: header says %d payload bytes, file has room for %d", ErrTruncated, n, avail)
	}
	if n < avail {
		return nil, fmt.Errorf("%w: %d unexpected bytes after the payload", ErrCorrupt, avail-n)
	}
	body := data[:headerSize+n]
	stored := binary.LittleEndian.Uint32(data[headerSize+n:])
	if got := crc32.Checksum(body, castagnoli); got != stored {
		return nil, fmt.Errorf("%w (stored %08x, computed %08x)", ErrChecksum, stored, got)
	}
	return decodePayload(data[headerSize : headerSize+n])
}

type payloadReader struct {
	b   []byte
	err error
}

func (r *payloadReader) uvarint(what string) uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.b)
	if n <= 0 {
		r.err = fmt.Errorf("%w: bad varint for %s", ErrCorrupt, what)
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *payloadReader) bytes(what string) []byte {
	n := r.uvarint(what)
	if r.err != nil {
		return nil
	}
	if n > uint64(len(r.b)) {
		r.err = fmt.Errorf("%w: %s runs past the end", ErrCorrupt, what)
		return nil
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func decodePayload(p []byte) (*Collection, error) {
	r := &payloadReader{b: p}
	var cfg Config
	cfg.Name = string(r.bytes("name"))
	cfg.Metric = string(r.bytes("metric"))
	cfg.Dim = int(r.uvarint("dim"))
	cfg.M = int(r.uvarint("m"))
	cfg.EfConstruction = int(r.uvarint("ef_construction"))
	cfg.EfSearch = int(r.uvarint("ef_search"))
	graph := r.bytes("graph")
	if r.err != nil {
		return nil, r.err
	}
	c, err := NewCollection(cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: config: %v", ErrCorrupt, err)
	}
	idx, err := hnsw.UnmarshalBinary(graph)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	ic := idx.Config()
	if ic.Dim != cfg.Dim || ic.Metric.String() != c.cfg.Metric || ic.M != cfg.M {
		return nil, fmt.Errorf("%w: graph config %+v doesn't match collection config %+v", ErrCorrupt, ic, cfg)
	}
	c.index = idx
	slots := idx.Slots()
	c.keys = make([]string, slots)
	c.meta = make([]map[string]any, slots)

	count := r.uvarint("document count")
	if r.err == nil && count != uint64(idx.Len()) {
		return nil, fmt.Errorf("%w: %d documents for %d live graph nodes", ErrCorrupt, count, idx.Len())
	}
	for i := uint64(0); i < count && r.err == nil; i++ {
		node := r.uvarint("node id")
		id := string(r.bytes("document id"))
		meta := r.bytes("metadata")
		if r.err != nil {
			break
		}
		if node >= uint64(slots) || !idx.IsLive(uint32(node)) || c.keys[node] != "" {
			return nil, fmt.Errorf("%w: document %q points at invalid node %d", ErrCorrupt, id, node)
		}
		if _, dup := c.byID[id]; dup || id == "" {
			return nil, fmt.Errorf("%w: duplicate or empty document id %q", ErrCorrupt, id)
		}
		if len(meta) > 0 {
			if err := json.Unmarshal(meta, &c.meta[node]); err != nil {
				return nil, fmt.Errorf("%w: metadata for %q: %v", ErrCorrupt, id, err)
			}
		}
		c.keys[node] = id
		c.byID[id] = uint32(node)
	}
	if r.err != nil {
		return nil, r.err
	}
	if len(r.b) != 0 {
		return nil, fmt.Errorf("%w: %d trailing payload bytes", ErrCorrupt, len(r.b))
	}
	return c, nil
}

// Dirty reports whether the collection changed since it was last saved.
func (c *Collection) Dirty() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.version != c.saved.Load()
}

// markSaved records that the state at write version v is on disk.
func (c *Collection) markSaved(v uint64) {
	for {
		old := c.saved.Load()
		if v <= old || c.saved.CompareAndSwap(old, v) {
			return
		}
	}
}

// SaveFile writes a snapshot to path atomically: it writes a temp file in
// the same directory, syncs it, and renames it over path, so a crash mid
// save leaves the previous snapshot intact.
func (c *Collection) SaveFile(path string) error {
	data, version, err := c.MarshalSnapshot()
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, data); err != nil {
		return err
	}
	c.markSaved(version)
	return nil
}

// LoadFile reads a snapshot written by SaveFile.
func LoadFile(path string) (*Collection, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c, err := UnmarshalSnapshot(data)
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", path, err)
	}
	return c, nil
}

func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync() // make the rename durable; best effort
		_ = d.Close()
	}
	return nil
}
