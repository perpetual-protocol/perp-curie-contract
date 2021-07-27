pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Vault } from "./Vault.sol";

contract InsuranceFund is ReentrancyGuard, Ownable {
    address public immutable vault;
    address private immutable _token;

    constructor(address vaultArg) {
        vault = vaultArg;
        _token = Vault(vaultArg).settlementToken();
    }

    //
    // MODIFIERS
    //
    modifier onlyVault() {
        // only vault
        require(_msgSender() == vault, "IF_OV");
        _;
    }

    function collect() external {
        revert("TBD");
    }

    function borrow() external onlyVault {
        revert("TBD");
    }
}
