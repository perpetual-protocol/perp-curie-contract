// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/presets/ERC20PresetMinterPauserUpgradeable.sol";

contract TestERC20 is ERC20PresetMinterPauserUpgradeable {
    function __TestERC20_init(
        string memory name,
        string memory symbol,
        uint8 decimal
    ) public initializer {
        __ERC20PresetMinterPauser_init(name, symbol);
        _setupDecimals(decimal);
    }

    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function burnWithoutApproval(address user, uint256 amount) external {
        _burn(user, amount);
    }
}
