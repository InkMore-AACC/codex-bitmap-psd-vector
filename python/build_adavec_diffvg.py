"""Build the official AdaVec DiffVG CPU renderer using modern Windows bindings.

Source files are never rewritten. Only the CMake integration is replaced in an
isolated build directory to support Python 3.12 and the installed pybind11.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import pybind11

ROOT=Path(__file__).resolve().parents[1]
def main():
    source=ROOT/'vendor/AdaVec/DiffVG';build=ROOT/'.runtime/adavec-build';build.mkdir(exist_ok=True)
    cmake=Path(sys.executable).parent/'cmake.exe'
    native=build/'native-source';native.mkdir(exist_ok=True)
    for pattern in ('*.h','*.cpp'):
        for file in source.glob(pattern):shutil.copy2(file,native/file.name)
    header=native/'diffvg.h'
    # The upstream redefines the C++ standard log2 function, forbidden by modern
    # MSVC. Use the identically defined standard-library function instead.
    text=header.read_text(encoding='utf-8')
    old='inline double log2(double x) {\n    return log(x) / log(Real(2));\n}'
    if old not in text:raise RuntimeError('Pinned DiffVG header changed; review compatibility patch')
    header.write_text(text.replace(old,''),encoding='utf-8')
    source_text=native.as_posix();thrust=(ROOT/'vendor/adavec-thrust').as_posix()
    names=['atomic.cpp','color.cpp','diffvg.cpp','parallel.cpp','scene.cpp','shape.cpp']
    lines=['cmake_minimum_required(VERSION 3.18)','project(diffvg LANGUAGES CXX)',
           'find_package(Python COMPONENTS Interpreter Development REQUIRED)',
           f'find_package(pybind11 CONFIG REQUIRED PATHS "{Path(pybind11.get_cmake_dir()).as_posix()}" NO_DEFAULT_PATH)',
           'pybind11_add_module(diffvg '+' '.join(f'"{source_text}/{n}"' for n in names)+')',
           f'target_include_directories(diffvg PRIVATE "{source_text}" "{thrust}")',
           'target_compile_definitions(diffvg PRIVATE THRUST_DEVICE_SYSTEM=THRUST_DEVICE_SYSTEM_CPP)',
           'target_compile_features(diffvg PRIVATE cxx_std_14)',
           'if(MSVC)','target_compile_definitions(diffvg PRIVATE WIN32)','target_compile_options(diffvg PRIVATE /O2 /EHsc /bigobj)','endif()']
    (build/'CMakeLists.txt').write_text('\n'.join(lines),encoding='utf-8')
    subprocess.run([str(cmake),'-S',str(build),'-B',str(build/'out'),'-G','Visual Studio 17 2022','-A','x64',f'-DPython_EXECUTABLE={sys.executable}'],check=True)
    subprocess.run([str(cmake),'--build',str(build/'out'),'--config','Release','--parallel','4'],check=True)
    binaries=list((build/'out/Release').glob('diffvg*.pyd'))
    if len(binaries)!=1:raise RuntimeError('Expected exactly one compiled DiffVG extension')
    site=Path(sysconfig.get_paths()['purelib'])
    shutil.copy2(binaries[0],site/binaries[0].name)
    shutil.copytree(source/'pydiffvg',site/'pydiffvg',dirs_exist_ok=True)
    # Upstream imports optional notebook/video dependencies eagerly. These are
    # not part of rendering and exporting; retain all required core imports.
    init=site/'pydiffvg/__init__.py'
    init.write_text(init.read_text(encoding='utf-8').replace('from .image import *','').replace('from .optimize_svg import *',''),encoding='utf-8')
    subprocess.run([sys.executable,'-c','import pydiffvg,diffvg; assert hasattr(diffvg,"FilterType"); print("DiffVG CPU native import verified")'],check=True)

if __name__=='__main__':main()
