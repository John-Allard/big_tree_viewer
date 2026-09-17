"""Build BTV's connected radial-tree icon and raster variants.

Requires Inkscape and Pillow. Geometry is a rooted binary tree: each child
attaches to its parent's circular connector, with all leaves at one radius.
The colored annuli encode five contiguous clades, like taxonomy ribbons.
"""
from pathlib import Path
import math
import subprocess
import tempfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
GROUPS = [
    (4, 150, 24, '#E56B55'),  # Actinopteri: coral
    (153, 194, 8, '#E8AC50'),  # Amphibia: amber
    (197, 235, 8, '#35BFAE'),  # Mammalia: teal
    (238, 285, 8, '#A6D650'),  # Lepidosauria: lime
    (288, 358, 16, '#7160CF'),  # Aves: violet, distinct from coral
]


def point(radius, angle):
    a = math.radians(angle)
    return f'{256 + radius * math.cos(a):.3f} {256 + radius * math.sin(a):.3f}'


def arc(radius, start, end):
    return f'M {point(radius, start)} A {radius} {radius} 0 {int(end-start > 180)} 1 {point(radius, end)}'


def subtree(angles, color):
    if len(angles) == 1:
        return dict(angle=angles[0], radius=158, color=color, children=[])
    mid = len(angles) // 2
    children = [subtree(angles[:mid], color), subtree(angles[mid:], color)]
    return dict(angle=sum(c['angle'] for c in children)/2,
                radius=min(c['radius'] for c in children)-17,
                color=color, children=children)


def join(left, right, radius):
    return dict(angle=(left['angle']+right['angle'])/2, radius=radius,
                color='#445164', children=[left, right])


def svg():
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">',
             '<title>Big Tree Viewer</title>',
             '<desc>A connected radial phylogenetic tree surrounded by two colored taxonomy ribbons.</desc>',
             '<circle cx="256" cy="256" r="246" fill="white"/>',
             '<g stroke-linecap="butt">']
    clades = []
    for start, end, count, color in GROUPS:
        parts.append(f'<path d="{arc(222, start, end)}" stroke="{color}" stroke-width="46"/>')
        # Three subordinate blocks per class, separated by fine white gaps.
        for j in range(3):
            lo = start + (end-start)*j/3 + .55
            hi = start + (end-start)*(j+1)/3 - .55
            parts.append(f'<path d="{arc(182, lo, hi)}" stroke="{color}" stroke-opacity="{[.72,.95,.82][j]}" stroke-width="19"/>')
        angles = [start+2 + (end-start-4)*i/(count-1) for i in range(count)]
        clades.append(subtree(angles, color))
    parts.append('</g><g stroke-linecap="round" stroke-linejoin="round">')
    tree = join(join(clades[0], clades[1], 49), join(clades[2], join(clades[3], clades[4], 57), 37), 22)
    parts.append(f'<path d="M 256 256 L {point(tree["radius"], tree["angle"])}" stroke="#445164" stroke-width="5"/>')

    def draw(node):
        if not node['children']:
            return
        a, b = node['children']
        width = 4.5 if node['color'] == '#445164' else 3.7
        parts.append(f'<path d="{arc(node["radius"], a["angle"], b["angle"])}" stroke="{node["color"]}" stroke-width="{width}"/>')
        for child in node['children']:
            parts.append(f'<path d="M {point(node["radius"], child["angle"])} L {point(child["radius"], child["angle"])}" stroke="{child["color"]}" stroke-width="{width}"/>')
            draw(child)
    draw(tree)
    parts.append('</g></svg>')
    return '\n'.join(parts)+'\n'


if __name__ == '__main__':
    source = PUBLIC / 'favicon.svg'
    source.write_text(svg())
    with tempfile.TemporaryDirectory(prefix='btv-icons-') as temp:
        large = Path(temp) / 'icon.png'
        subprocess.run(['inkscape', str(source), '--export-type=png',
                        f'--export-filename={large}', '--export-width=2048',
                        '--export-height=2048'], check=True, capture_output=True)
        im = Image.open(large).convert('RGBA')
        for name, size in [('icon-512.png',512), ('icon-192.png',192),
                           ('apple-touch-icon.png',180), ('favicon-32x32.png',32)]:
            im.resize((size,size), Image.Resampling.LANCZOS).save(PUBLIC/name)
        im.resize((256,256), Image.Resampling.LANCZOS).save(
            PUBLIC/'favicon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
    print('Generated SVG, PNG, and ICO icons.')
