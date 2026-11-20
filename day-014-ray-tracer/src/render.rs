//! Turning colors into pixels and pixels into PNG files.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::vec3::Color;

/// An 8-bit RGB image, rows top to bottom.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, RGB.
    pub pixels: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32) -> Self {
        Image {
            width,
            height,
            pixels: vec![0; (width * height * 3) as usize],
        }
    }

    pub fn set(&mut self, x: u32, y: u32, rgb: [u8; 3]) {
        let i = ((y * self.width + x) * 3) as usize;
        self.pixels[i..i + 3].copy_from_slice(&rgb);
    }

    pub fn get(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.width + x) * 3) as usize;
        [self.pixels[i], self.pixels[i + 1], self.pixels[i + 2]]
    }

    /// Encode as PNG into any writer.
    pub fn write_png_to<W: Write>(&self, out: W) -> Result<(), png::EncodingError> {
        let mut encoder = png::Encoder::new(out, self.width, self.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Best);
        encoder.set_adaptive_filter(png::AdaptiveFilterType::Adaptive);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&self.pixels)?;
        writer.finish()
    }

    /// The PNG file as bytes.
    pub fn png_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        self.write_png_to(&mut bytes)
            .expect("encoding into a Vec cannot fail");
        bytes
    }

    /// Write a PNG file, creating parent directories as needed.
    pub fn save_png(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let file = BufWriter::new(File::create(path)?);
        self.write_png_to(file).map_err(std::io::Error::other)
    }
}

/// Map a linear color in `[0, 1]` to bytes, clamping anything out of range.
pub fn color_to_rgb(color: Color) -> [u8; 3] {
    let byte = |c: f64| {
        let c = if c.is_nan() { 0.0 } else { c.clamp(0.0, 0.999) };
        (256.0 * c) as u8
    };
    [byte(color.x), byte(color.y), byte(color.z)]
}

/// The "hello world" image: red grows left to right, green grows bottom to top.
pub fn gradient(width: u32, height: u32) -> Image {
    let mut image = Image::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let r = x as f64 / (width - 1).max(1) as f64;
            let g = (height - 1 - y) as f64 / (height - 1).max(1) as f64;
            image.set(x, y, color_to_rgb(Color::new(r, g, 0.25)));
        }
    }
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_to_rgb_maps_and_clamps() {
        assert_eq!(color_to_rgb(Color::new(0.0, 0.5, 1.0)), [0, 128, 255]);
        assert_eq!(color_to_rgb(Color::new(-1.0, 2.0, f64::NAN)), [0, 255, 0]);
        assert_eq!(color_to_rgb(Color::new(0.25, 0.75, 0.999)), [64, 192, 255]);
    }

    #[test]
    fn set_and_get_pixels() {
        let mut image = Image::new(3, 2);
        assert_eq!(image.pixels.len(), 18);
        image.set(2, 1, [1, 2, 3]);
        assert_eq!(image.get(2, 1), [1, 2, 3]);
        assert_eq!(image.get(0, 0), [0, 0, 0]);
        assert_eq!(&image.pixels[15..18], &[1, 2, 3]);
    }

    #[test]
    fn gradient_corners() {
        let image = gradient(5, 4);
        // Top-left: no red, full green. Bottom-right: full red, no green.
        assert_eq!(image.get(0, 0), [0, 255, 64]);
        assert_eq!(image.get(4, 3), [255, 0, 64]);
        assert_eq!(image.get(4, 0), [255, 255, 64]);
        assert_eq!(image.get(0, 3), [0, 0, 64]);
    }

    #[test]
    fn png_round_trip() {
        let image = gradient(16, 9);
        let bytes = image.png_bytes();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");

        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (16, 9));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(&buf[..info.buffer_size()], &image.pixels[..]);
    }

    #[test]
    fn save_png_creates_directories() {
        let dir = std::env::temp_dir().join(format!("rt-save-{}", std::process::id()));
        let path = dir.join("nested/out.png");
        gradient(4, 4).save_png(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, gradient(4, 4).png_bytes());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_png_reports_io_errors() {
        // A path under a regular file can't be created.
        let file = std::env::temp_dir().join(format!("rt-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(gradient(2, 2).save_png(&file.join("out.png")).is_err());
        std::fs::remove_file(&file).unwrap();
    }
}
