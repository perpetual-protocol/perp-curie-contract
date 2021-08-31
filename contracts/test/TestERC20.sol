// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
import "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";

contract TestERC20 is ERC20PresetMinterPauser {
    constructor(string memory name, string memory symbol) public ERC20PresetMinterPauser(name, symbol) {}

    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function setupDecimals(uint8 decimal) external {
        _setupDecimals(decimal);
    }
}
