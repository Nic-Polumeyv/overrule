//! rustc-hash 2.1.2's FxHasher, inlined: the algorithm is fifteen lines and
//! was the crate's whole job here. Bit-identical on the 64-bit little-endian
//! targets releases build for, pinned by the reference-value test below; the
//! upstream 32-bit fallbacks are dropped.

use std::hash::{BuildHasherDefault, Hasher};

pub type FxHashMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<FxHasher>>;
pub type FxHashSet<V> = std::collections::HashSet<V, BuildHasherDefault<FxHasher>>;

const K: u64 = 0xf1357aea2e62a9c5;
const SEED1: u64 = 0x243f6a8885a308d3;
const SEED2: u64 = 0x13198a2e03707344;
const PREVENT_TRIVIAL_ZERO_COLLAPSE: u64 = 0xa4093822299f31d0;

#[derive(Default)]
pub struct FxHasher {
    hash: u64,
}

impl FxHasher {
    fn add_to_hash(&mut self, i: u64) {
        self.hash = self.hash.wrapping_add(i).wrapping_mul(K);
    }
}

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        self.add_to_hash(hash_bytes(bytes));
    }
    fn write_u8(&mut self, i: u8) {
        self.add_to_hash(i as u64);
    }
    fn write_u16(&mut self, i: u16) {
        self.add_to_hash(i as u64);
    }
    fn write_u32(&mut self, i: u32) {
        self.add_to_hash(i as u64);
    }
    fn write_u64(&mut self, i: u64) {
        self.add_to_hash(i);
    }
    fn write_u128(&mut self, i: u128) {
        self.add_to_hash(i as u64);
        self.add_to_hash((i >> 64) as u64);
    }
    fn write_usize(&mut self, i: usize) {
        self.add_to_hash(i as u64);
    }
    fn finish(&self) -> u64 {
        self.hash.rotate_left(26)
    }
}

fn multiply_mix(x: u64, y: u64) -> u64 {
    let full = (x as u128).wrapping_mul(y as u128);
    (full as u64) ^ ((full >> 64) as u64)
}

/// A byte string folded to one u64: word-at-a-time for short inputs, a
/// two-stream mix over 16-byte chunks for long ones, the length folded in
/// last.
fn hash_bytes(bytes: &[u8]) -> u64 {
    let len = bytes.len();
    let mut s0 = SEED1;
    let mut s1 = SEED2;

    if len <= 16 {
        if len >= 8 {
            s0 ^= u64::from_le_bytes(bytes[0..8].try_into().expect("eight bytes"));
            s1 ^= u64::from_le_bytes(bytes[len - 8..].try_into().expect("eight bytes"));
        } else if len >= 4 {
            s0 ^= u32::from_le_bytes(bytes[0..4].try_into().expect("four bytes")) as u64;
            s1 ^= u32::from_le_bytes(bytes[len - 4..].try_into().expect("four bytes")) as u64;
        } else if len > 0 {
            s0 ^= bytes[0] as u64;
            s1 ^= ((bytes[len - 1] as u64) << 8) | bytes[len / 2] as u64;
        }
    } else {
        // Chunks stop one byte early so the 16-byte suffix always overlaps
        // the tail instead of leaving a short remainder.
        let mut bulk = &bytes[..len - 1];
        while let Some((chunk, rest)) = bulk.split_first_chunk::<16>() {
            let x = u64::from_le_bytes(chunk[..8].try_into().expect("eight bytes"));
            let y = u64::from_le_bytes(chunk[8..].try_into().expect("eight bytes"));
            let t = multiply_mix(s0 ^ x, PREVENT_TRIVIAL_ZERO_COLLAPSE ^ y);
            s0 = s1;
            s1 = t;
            bulk = rest;
        }
        let suffix = &bytes[len - 16..];
        s0 ^= u64::from_le_bytes(suffix[0..8].try_into().expect("eight bytes"));
        s1 ^= u64::from_le_bytes(suffix[8..16].try_into().expect("eight bytes"));
    }

    multiply_mix(s0, s1) ^ (len as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hash::BuildHasher;

    #[test]
    fn hashes_match_rustc_hash_2_1_2() {
        // Reference values from rustc-hash 2.1.2 on x86_64; a mismatch means
        // hash-order-dependent behavior may have silently changed.
        let build = BuildHasherDefault::<FxHasher>::default();
        for (input, expected) in [
            ("", 0xc15c636231f9c328u64),
            ("a", 0x54494a0e72ff0634),
            ("p-2", 0xf7641b23faf9d140),
            ("flex h-9", 0x40b16458d1be9b0c),
            (
                "0123456789abcdef-longer-than-sixteen-bytes",
                0x74326891370afd6b,
            ),
        ] {
            assert_eq!(build.hash_one(input), expected, "input: {input:?}");
        }
        assert_eq!(build.hash_one(12345usize), 0x5b4f32f376efd11b);
    }
}
