# HCP-MMP1.0 cortical atlas

`glasser-fsaverage5.json` derives from Kevin Mills' **HCP-MMP1.0 projected on fsaverage**, version 2, [doi:10.6084/m9.figshare.3498446.v2](https://doi.org/10.6084/m9.figshare.3498446.v2), released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Original parcellation: Glasser et al. (2016), *A multi-modal parcellation of human cerebral cortex*, [doi:10.1038/nature18933](https://doi.org/10.1038/nature18933).

Changes: retained fsaverage vertices numbered 0–10,241 in each hemisphere, shifted right-hemisphere indices by 10,242, and combined left/right vertices under each bare parcel name. These are the same annotation files, nesting operation and bilateral grouping used by the TRIBE scoring worker. Source file checksums are in the JSON. No mesh or model weights are bundled.
