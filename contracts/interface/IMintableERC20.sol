// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IERC20Metadata } from "./IERC20Metadata.sol";

interface IMintableERC20 is IERC20Metadata {
    function mint(address to, uint256 amount) external;

    function burn(uint256 amount) external;
}
